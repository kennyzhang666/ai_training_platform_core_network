"""Code Agent 调用的批次适配器。结果索引由程序生成，避免人工拼 JSON。"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def write_atomic(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix='.coupon-',suffix='.tmp',dir=path.parent)
    try:
        with os.fdopen(descriptor,'w',encoding='utf-8',newline='\n') as stream:
            json.dump(value,stream,ensure_ascii=False,indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        Path(name).replace(path)
    finally:
        Path(name).unlink(missing_ok=True)


def inside(value, root):
    path=Path(value)
    path=(root/path).resolve() if not path.is_absolute() else path.resolve()
    if not path.is_relative_to(root.resolve()): raise ValueError('结果路径不在本批次允许目录')
    return path


def run(manifest_path):
    manifest_path=manifest_path.resolve()
    manifest=json.loads(manifest_path.read_text(encoding='utf-8-sig'))
    root=manifest_path.parent
    if manifest.get('schemaVersion')!='1.1': raise ValueError('需要平台批次输入 v1.1')
    items=manifest['submissions']
    ids=[item['runId'] for item in items]
    if not ids or len(ids)!=len(set(ids)): raise ValueError('批次运行编号为空或重复')
    results_root=root/'results'
    index_path=inside(manifest['resultIndexPath'],root)
    if not index_path.is_relative_to(results_root.resolve()): raise ValueError('结果索引必须位于 results 目录')
    index={'schemaVersion':'1.0','batchId':manifest['batch']['id'],'results':[],'failures':[]}
    python=os.environ.get('AI_TRAINING_ENGINE_PYTHON',sys.executable)
    engine=manifest['engine']
    engine_root=Path(engine['root']).resolve()
    for item in items:
        try:
            output=inside(item['outputPath'],root)
            if not output.is_relative_to(results_root.resolve()) or output==index_path: raise ValueError('单人结果必须位于 results 目录，且不能覆盖索引')
            scratch=inside(item['scratchDir'],root)
            scratch.mkdir(parents=True,exist_ok=True)
            invocation={
                'schemaVersion':'1.0','generatedAt':datetime.now(timezone.utc).isoformat(),
                'engine':{'id':engine['id'],'version':engine['version'],'source':engine['source'],'packageHash':engine['packageHash'],'packageRoot':str(engine_root),'assets':engine.get('assets',{})},
                'challenge':manifest['challenge'],
                'grading':{'runId':item['runId'],'idempotencyKey':item['idempotencyKey'],'triggerType':item.get('triggerType','MANUAL'),'attempt':item.get('attempt',1)},
                'subject':item['subject'],'submission':item['submission'],'workspace':item['workspace'],'outputPath':str(output),'scratchDir':str(scratch),'limits':engine.get('limits',{}),'params':engine.get('params',{})}
            input_path=scratch/'coupon-invocation.json'
            write_atomic(input_path,invocation)
            entry=Path(engine['entrypoint'])
            if not entry.is_absolute(): entry=engine_root/entry
            child=subprocess.run([python,'-I',str(entry),'--input',str(input_path),'--output',str(output)],cwd=scratch,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=engine.get('limits',{}).get('wallClockSeconds',240),check=False)
            if child.returncode: raise ValueError(f'评测引擎退出码 {child.returncode}')
            result=json.loads(output.read_text(encoding='utf-8'))
            if result.get('gradingRunId')!=item['runId'] or result.get('idempotencyKey')!=item['idempotencyKey'] or result.get('submission',{}).get('snapshotHash')!=item['submission']['snapshotHash']:
                raise ValueError('结果与本次提交不匹配')
            index['results'].append({'runId':item['runId'],'resultPath':output.relative_to(root).as_posix()})
        except (OSError,ValueError,KeyError,subprocess.TimeoutExpired) as error:
            reason='评测超时' if isinstance(error,subprocess.TimeoutExpired) else str(error)[:200]
            index['failures'].append({'runId':item['runId'],'reason':reason})
    write_atomic(index_path,index)
    return index


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--manifest',default=os.environ.get('AI_TRAINING_BATCH_MANIFEST'))
    args=parser.parse_args()
    if not args.manifest: parser.error('缺少 --manifest')
    index=run(Path(args.manifest))
    print(json.dumps({'completed':len(index['results']),'failed':len(index['failures'])}))
