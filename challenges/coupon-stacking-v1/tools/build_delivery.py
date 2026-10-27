"""组装管理员交付目录，学员包、测试提交包与引擎包分别打包。"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parents[1]


def archive(source, output):
    files=[file for file in sorted(source.rglob('*')) if file.is_file() and '__pycache__' not in file.parts and file.suffix != '.pyc' and file.resolve()!=output.resolve()]
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as target:
        for file in files:
            info=zipfile.ZipInfo(file.relative_to(source).as_posix(),date_time=(2026,10,27,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=0o100644 << 16
            target.writestr(info,file.read_bytes())


def build(output):
    output.mkdir(parents=True,exist_ok=True)
    archive(ROOT/'engine',output/'coupon-stacking-v1-engine.zip')
    subprocess.run([sys.executable,str(PROJECT/'tools/engine-dev-kit/tools/engine_dev.py'),'validate',str(output/'coupon-stacking-v1-engine.zip')],check=True)
    archive(ROOT/'starter',output/'coupon-stacking-v1-starter.zip')
    archive(ROOT/'engine/assets/oracle',output/'coupon-stacking-v1-reference-submission.zip')
    archive(ROOT,output/'coupon-stacking-v1-author-source.zip')
    with zipfile.ZipFile(output/'coupon-stacking-v1-author-source.zip','a',zipfile.ZIP_DEFLATED) as source_archive:
        source_archive.write(PROJECT/'services/platform-api/test/coupon-stacking-v1-engine.test.ts','platform-tests/coupon-stacking-v1-engine.test.ts')
    for file in ['网页配置内容.md','README.md','submission-contract.json','challenge.yaml']:
        shutil.copyfile(ROOT/file,output/file)
    shutil.copyfile(ROOT/'starter/INPUT_OUTPUT_EXAMPLES.md',output/'输入输出样例.md')
    shutil.copyfile(ROOT/'tools/equivalence-review.md',output/'评测设计与变异复核.md')
    shutil.copyfile(PROJECT/'docs/challenges/coupon-stacking-v1.md',output/'题目与评测设计任务书.md')
    if (ROOT/'验收记录.md').is_file(): shutil.copyfile(ROOT/'验收记录.md',output/'验收记录.md')
    hashes={file.name:hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(output.glob('*.zip')) if file.name!='coupon-stacking-v1-complete.zip'}
    (output/'sha256.json').write_text(json.dumps(hashes,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    engine=json.loads((ROOT/'engine/engine.json').read_text(encoding='utf-8'))
    configuration={'id':engine['id'],'version':engine['version'],'mode':'PACKAGED','agent':{'instructionPath':'instruction.md','skillPaths':['skills/evaluation']},'input':{'format':'JSON','schemaVersion':'1.1','contractPath':'contracts/evaluation-agent-batch-v1.1.schema.json'},'output':{'format':'JSON','schemaVersion':'1.0','contractPath':'contracts/evaluation-result.schema.json'}}
    (output/'评测配置参考.json').write_text(json.dumps(configuration,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    subprocess.run([sys.executable,str(PROJECT/'tools/engine-dev-kit/tools/engine_dev.py'),'run',str(output/'coupon-stacking-v1-engine.zip'),'--workspace',str(ROOT/'engine/assets/oracle'),'--output',str(output/'reference-result.json')],check=True)
    result=json.loads((output/'reference-result.json').read_text(encoding='utf-8'))
    if result['total']!=100: raise ValueError('参考交付件未达到 100 分，不生成完整交付包')
    archive(output,output/'coupon-stacking-v1-complete.zip')
    # package 字段由平台上传接口按实际归档生成，不能预造引擎包 ID。
    print(json.dumps({'output':str(output),'archives':hashes},ensure_ascii=True))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--out',type=Path,default=PROJECT/'release/coupon-stacking-v1')
    build(parser.parse_args().out.resolve())
