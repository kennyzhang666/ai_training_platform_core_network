"""从参考实现生成冻结变体。只接受恰好命中一次的声明式替换。"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def apply(source, patches):
    for before, after in patches:
        if source.count(before) != 1:
            raise ValueError(f'补丁必须恰好匹配一次：{before!r}')
        source = source.replace(before, after, 1)
    compile(source, '<variant>', 'exec')
    return source


def generate(check=False):
    base = ROOT / 'engine/assets/variants'
    reference = (base / 'reference.py').read_text(encoding='utf-8')
    definitions = json.loads((ROOT / 'tools/variant-patches.json').read_text(encoding='utf-8'))['variants']
    records = [{'id': 'reference', 'type': 'reference', 'path': 'reference.py', 'sha256': hashlib.sha256(reference.encode()).hexdigest()}]
    contents = {}
    folders = {'previous': '', 'bug': 'bugs/', 'interpretation': 'interpretations/', 'mutant': 'mutants/'}
    for definition in definitions:
        relative = folders[definition['type']] + definition['id'] + '.py'
        content = apply(reference, definition['patches'])
        contents[base / relative] = content
        records.append({k: v for k, v in definition.items() if k != 'patches'} | {'path': relative, 'sha256': hashlib.sha256(content.encode()).hexdigest()})
    starter = reference
    for definition in definitions:
        if definition['type'] == 'bug':
            starter = apply(starter, definition['patches'])
    contents[ROOT / 'starter/src/pricing.py'] = starter
    contract = ROOT / 'submission-contract.json'
    if contract.is_file():
        contents[ROOT / 'engine/assets/submission-contract.json'] = contract.read_text(encoding='utf-8')
    contents[base / 'manifest.json'] = json.dumps({'schemaVersion': '1.0', 'variants': records}, ensure_ascii=False, indent=2) + '\n'
    for destination, content in contents.items():
        if check:
            if not destination.exists() or destination.read_bytes() != content.encode('utf-8'):
                raise ValueError(f'生成结果不一致：{destination.relative_to(ROOT)}')
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content.encode('utf-8'))
    print(f'{len(records)} 个冻结版本，' + ('重现检查通过' if check else '生成完成'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    generate(parser.parse_args().check)
