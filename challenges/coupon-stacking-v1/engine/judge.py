"""超市优惠测试套件确定性评分入口。仅使用 Python 标准库。"""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

# -I 模式仍需要显式加载同包模块，不能依赖 cwd 或 PYTHONPATH。
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('coupon_lint', ROOT / 'lint.py')
_lint = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_lint)
LEVEL_RATIO = {'A': 1.0, 'B': .75, 'C': .5, 'D': 0.0}
REQUIRED = ['tests/test_quote.py', 'DEFECTS.md', 'TEST_PLAN.md', 'AI_WORKLOG.md']
PLAN_HEADINGS = ['等价类与边界', '组合策略', '规格空白', '变更影响', '不覆盖说明']
WORK_HEADINGS = ['约束下达', 'AI 输出核验', '失败判定', '迭代记录']
RUBRIC = [('V1','verify',8,'主流程验证'),('V2','verify',12,'异常与边界验证'),('V3','verify',12,'需求澄清与规则验证'),('V4','verify',8,'变更回归验证'),('S1','spec',6,'需求澄清'),('S2','spec',8,'验收用例设计'),('S3','spec',6,'异常与边界覆盖'),('S4','spec',5,'变更影响定位'),('C1','code',5,'业务常量管理'),('C2','code',5,'异常与边界处理'),('C3','code',5,'类型与精度安全'),('C4','code',5,'变更友好设计'),('P1','collab',4,'需求与验收先行'),('P2','collab',3,'小步迭代'),('P3','collab',4,'提示词设计'),('P4','collab',4,'变更定位与验证')]


def utc():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def read(path):
    return path.read_text(encoding='utf-8-sig', errors='replace') if path.is_file() else ''


def run_suite(source, test_source, seed=1, valid_ids=None, timeout=10, scratch=None):
    started = time.monotonic()
    env = {'PYTHONHASHSEED': str(seed), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8', 'PATH': os.environ.get('PATH', '')}
    if os.name == 'nt': env['SYSTEMROOT'] = os.environ.get('SYSTEMROOT', r'C:\Windows')
    with tempfile.TemporaryDirectory(prefix='coupon-case-', dir=scratch) as name:
        directory = Path(name)
        shutil.copyfile(source, directory / 'pricing.py')
        (directory / 'test_quote.py').write_text(test_source, encoding='utf-8')
        report = directory / 'out.jsonl'
        command = [sys.executable, '-s', '-P', str(ROOT / 'runner.py'), '--directory', str(directory), '--output', str(report), '--order-seed', str(seed)]
        if valid_ids is not None:
            selection = directory / 'selection.json'
            selection.write_text(json.dumps(valid_ids), encoding='utf-8')
            command += ['--ids', str(selection)]
        timed_out = False
        try:
            child = subprocess.run(command, cwd=directory, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
            failed = child.returncode != 0
        except subprocess.TimeoutExpired:
            timed_out, failed = True, True
        records = []
        if report.is_file():
            try:
                records = [json.loads(line) for line in read(report).splitlines() if line]
            except (ValueError, TypeError):
                failed = True
        return {'records': records, 'timeout': timed_out, 'processFailed': failed, 'seconds': time.monotonic()-started}


def analyze_runs(workspace, include_mutants=True, inspect=False, scratch=None):
    test_source = read(workspace / 'tests/test_quote.py')
    static = _lint.analyze(test_source)
    base = ROOT / 'assets/variants'
    manifest = json.loads(read(base / 'manifest.json'))['variants']
    for variant in manifest:
        if hashlib.sha256((base / variant['path']).read_bytes()).hexdigest() != variant['sha256']:
            raise ValueError('评测引擎文件校验失败，请重新上传完整引擎包')
    reference = [run_suite(base / 'reference.py', test_source, seed, scratch=scratch) for seed in (1,2,3)] if not static['violations'] and not static['syntaxError'] else []
    maps = [{r['id']: r for r in run['records'] if r['id'] != '__collection__'} for run in reference]
    ids = sorted(set(static['testIds']).union(*(set(m) for m in maps)))
    fatal = not reference or any(r['timeout'] or r['processFailed'] or any(item['id'] == '__collection__' for item in r['records']) for r in reference)
    outcomes = {id_: [m.get(id_, {}).get('outcome', 'error') for m in maps] for id_ in ids}
    unstable = [id_ for id_, values in outcomes.items() if len(set(values)) > 1] if not fatal else []
    valid = [id_ for id_, values in outcomes.items() if values == ['pass']*3] if not fatal else []
    invalid = [id_ for id_ in ids if id_ not in valid and id_ not in unstable]
    classified = {'previous': [], 'gap': [], 'fixed': [], 'other': []}
    found, misread, variant_runs, failures, killed = {}, {}, {}, {}, set()
    for variant in manifest:
        kind, key = variant['type'], variant['id']
        if kind == 'reference' or (kind == 'mutant' and not include_mutants): continue
        if kind == 'mutant' and not valid: continue
        if static['violations'] or static['syntaxError'] or (reference and any(r['timeout'] for r in reference)): continue
        run = run_suite(base / variant['path'], test_source, valid_ids=valid if kind == 'mutant' and not inspect else None, scratch=scratch)
        variant_runs[key] = run
        rows = {row['id']: row for row in run['records']}
        failed = {id_ for id_, row in rows.items() if row['outcome'] in {'fail','error'}}
        failures[key] = sorted(failed)
        if kind == 'mutant' and (run['timeout'] or bool(failed.intersection(valid))): killed.add(key)
        if kind == 'bug': found[key] = sorted(failed.intersection(valid))
        if kind == 'interpretation': misread[key] = [id_ for id_ in invalid if rows.get(id_, {}).get('outcome') == 'pass']
    for id_ in invalid:
        if any(row['id'] == id_ and row['outcome'] == 'pass' for row in variant_runs.get('v1_reference', {}).get('records', [])):
            classified['previous'].append(id_)
        elif any(id_ in values for values in misread.values()): classified['gap'].append(id_)
        elif any(any(row['id'] == id_ and row['outcome'] == 'pass' for row in variant_runs.get(f'B{i}', {}).get('records', [])) for i in range(1,5)):
            classified['fixed'].append(id_)
        else: classified['other'].append(id_)
    b1_invalid_pass = any(row['id'] in invalid and row['outcome']=='pass' for row in variant_runs.get('B1',{}).get('records',[]))
    data = {'static': static, 'reference': reference, 'ids': ids, 'valid': valid, 'invalid': invalid, 'unstable': unstable, 'classified': classified, 'found': found, 'misread': misread, 'killed': killed, 'manifest': manifest, 'fatal': fatal, 'b1InvalidPass':b1_invalid_pass}
    if inspect:
        starter = ROOT.parent / 'starter/src/pricing.py'
        run = run_suite(starter, test_source, scratch=scratch)
        data.update(failedByVariant=failures, starterFailed=[row['id'] for row in run['records'] if row['outcome'] != 'pass'])
    return data


def inspect_variants(workspace):
    return analyze_runs(Path(workspace), inspect=True)


def section(document, heading):
    found = re.search(r'^##\s+' + re.escape(heading) + r'\s*$([\s\S]*?)(?=^##\s|\Z)', document, re.M)
    return found.group(1) if found else ''


def entries(document):
    return [line.strip() for line in document.splitlines() if re.match(r'^\s*(?:[-*+]\s+|\d+[.、)]\s*)', line)]


def _level(passed, total):
    ratio = passed / total if total else 0
    return 'A' if ratio == 1 else 'B' if ratio >= .75 else 'C' if ratio >= .5 else 'D'


def evaluate_workspace(workspace, scratch=None):
    workspace = Path(workspace)
    data = analyze_runs(workspace, scratch=scratch)
    static, valid, killed = data['static'], data['valid'], data['killed']
    files = {file: read(workspace / file) for file in REQUIRED}
    plan, defects, worklog = files['TEST_PLAN.md'], files['DEFECTS.md'], files['AI_WORKLOG.md']
    plan_ok = len(plan) >= 800 and all(section(plan, heading).strip() for heading in PLAN_HEADINGS)
    work_ok = len(worklog) >= 800 and all(section(worklog, heading).strip() for heading in WORK_HEADINGS)
    defects_ok = len(defects) >= 200 and all(term in defects for term in ['缺陷编号','条款','失败测试','期望','实际'])
    found = data['found']
    gaps_ok = [bool(valid) and not data['misread'].get(f'G{i}') for i in range(1,4)]
    no_previous, no_fixed = bool(valid) and not data['classified']['previous'], bool(valid) and not data['classified']['fixed']
    checks = {}
    def add(key, description, passed, file='tests/test_quote.py'):
        checks.setdefault(key, []).append({'description': description, 'passed': bool(passed), 'file': file})
    for tier, key in [('basic','V1'),('boundary','V2'),('clarification','V3'),('change','V4')]:
        selected = [v for v in data['manifest'] if v.get('tier') == tier]
        for v in selected:
            add(key, f"{v['clause']} {v['category']}类测试", v['id'] in killed)
    add('V1','没有其它规格误读',bool(valid) and not data['classified']['other'])
    for ok in gaps_ok: add('V3','澄清记录得到正确应用',ok)
    add('V4','旧断言已更新',no_previous)
    add('V4','断言没有固化实现缺陷',no_fixed)
    for ok in gaps_ok: add('S1','澄清记录得到正确应用',ok,'TEST_PLAN.md')
    add('S1','规格空白至少三条',plan_ok and len(entries(section(plan,'规格空白'))) >= 3,'TEST_PLAN.md')
    add('S1','引用澄清记录',plan_ok and 'CLARIFICATIONS.md' in plan,'TEST_PLAN.md')
    for i, clause in [(1,'R5'),(2,'R7'),(3,'R5'),(4,'R3')]:
        discovered = found.get(f'B{i}', [])
        add('S2','发现待测实现中的缺陷',bool(discovered))
        rows = [line for line in defects.splitlines() if line.strip().startswith('|')]
        linked = any(clause in row and any(id_.split('.')[-1] in row for id_ in discovered) for row in rows)
        add('S2','缺陷报告关联条款与有效测试',defects_ok and linked,'DEFECTS.md')
    for clause in [f'R{i}' for i in range(1,9)]: add('S3',f'{clause} 有有效回归用例',any(v.get('clause')==clause and v['id'] in killed for v in data['manifest']))
    add('S4','旧选择规则已更新',no_previous,'TEST_PLAN.md')
    add('S4','遗留舍入断言已处理',bool(valid) and not data['b1InvalidPass'],'TEST_PLAN.md')
    for name in ['test_best_percent_coupon_selected','test_percent_tie_breaks_by_code','test_rounding_half']:
        add('S4','变更影响说明点名原测试',plan_ok and name in section(plan,'变更影响'),'TEST_PLAN.md')
    add('C1','至少一半测试采用数据表',static['methods']>0 and static['tableMethods']*2>=static['methods'])
    add('C1','至少一半测试引用规格条款',static['methods']>0 and static['clauseMethods']*2>=static['methods'])
    add('C1','没有被同名方法覆盖的测试',not static['duplicates'])
    for name, ok in [('每个测试都有明确断言',static['methods']>0 and static['assertions']),('没有低信息断言',not static['lowInformation']),('不吞断言异常',not static['swallowed']),('没有跳过或预期失败',not static['skips'])]: add('C2',name,ok)
    for name, ok in [('断言不用浮点字面量',not static['floatAssertions']),('不用近似相等掩盖金额差异',not static['almostEqual']),('不调用银行家舍入',not static['roundCalls'])]: add('C3',name,ok)
    for name, ok in [('不同种子与顺序下结果稳定',bool(valid) and not data['unstable']),('不读取模块私有信息',not static['privateAccess']),('参考实现单次运行不超过五秒',bool(data['reference']) and max(r['seconds'] for r in data['reference'])<=5)]: add('C4',name,ok)
    judgments = entries(section(worklog,'失败判定'))
    add('P1','至少两条有测试名的失败判定',work_ok and len([line for line in judgments if re.search(r'test_\w+',line)])>=2,'AI_WORKLOG.md')
    add('P1','测试设计章节完整',plan_ok,'TEST_PLAN.md')
    add('P2','至少三次迭代记录',work_ok and len(entries(section(worklog,'迭代记录')))>=3,'AI_WORKLOG.md')
    instructions = section(worklog,'约束下达')
    add('P3','保留原始约束内容',work_ok and bool(re.search(r'^\s*>|```',instructions,re.M)),'AI_WORKLOG.md')
    add('P3','指定规格与澄清为依据',work_ok and all(name in instructions for name in ['SPEC.md','CLARIFICATIONS.md']),'AI_WORKLOG.md')
    verifications = entries(section(worklog,'AI 输出核验'))
    add('P4','至少两条核验记录引用条款',work_ok and sum(bool(re.search(r'\b(?:R[1-8]|G[1-3])\b',line)) for line in verifications)>=2,'AI_WORKLOG.md')
    clauses = {clause for i,clause in [(1,'R5'),(2,'R7'),(3,'R5'),(4,'R3')] if found.get(f'B{i}')} | {'G1','G2','G3'}
    add('P4','核验涉及已发现缺陷或澄清',work_ok and any(re.search(r'\b'+clause+r'\b',line) for clause in clauses for line in verifications),'AI_WORKLOG.md')
    criteria, findings = [], []
    force = static['violations'] or not valid or data['fatal']
    for key, dim, maximum, name in RUBRIC:
        items = checks[key]
        if dim == 'verify' and force: items = [dict(item,passed=False) for item in items]
        passed = sum(item['passed'] for item in items)
        level = _level(passed,len(items))
        # 同条款同类别只保留数量，不输出变体编号、补丁、源码或隐藏期望值。
        groups = {}
        for item in items:
            group = groups.setdefault(item['description'], {'description':item['description'],'passed':0,'total':0})
            group['passed'] += int(item['passed']); group['total'] += 1
        criteria.append({'key':key,'dim':dim,'name':name,'max':maximum,'level':level,'score':maximum*LEVEL_RATIO[level],'source':'auto','rule':'按本评分点检查项通过比例分档：全过 A，至少 75% 为 B，至少 50% 为 C，其余 D。','rationale':f'{passed}/{len(items)} 项通过。','evidenceType':'test' if dim=='verify' else 'diagnostic','evidence':{'primaryPath':items[0]['file'],'checks':list(groups.values()),'passed':passed,'total':len(items)},'ruleVersion':'1.0'})
        if level!='A':
            descriptions = sorted({item['description'] for item in items if not item['passed']})
            detail = '仍有未发现的缺陷，或缺陷报告未关联有效测试。' if key=='S2' else '；'.join(descriptions)+'。'
            findings.append({'id':f'finding-{key.lower()}','dim':dim,'criteria':key,'severity':'major','title':name+'需补充','file':items[0]['file'],'line':1,'detail':detail,'fix':'根据规格补充可独立运行的测试与对应记录。'})
    invalid_rows = []
    for id_ in data['invalid']:
        row = next((row for run in data['reference'] for row in run['records'] if row['id']==id_ and row['outcome']!='pass'),{})
        message = row.get('message','测试未能在正确实现上通过')
        line=max(1,int(row.get('line',1)))
        source_lines=files['tests/test_quote.py'].splitlines()
        snippet=source_lines[line-1][:240] if line<=len(source_lines) else ''
        invalid_rows.append({'id':id_, 'message':message,'line':line})
        findings.append({'id':f'invalid-{len(invalid_rows)}','dim':'verify','criteria':'V1','severity':'major','title':'测试断言与规格不符','file':'tests/test_quote.py','line':line,'snippet':snippet,'detail':id_+': '+message,'fix':'从 SPEC.md、CLARIFICATIONS.md 和 CHANGE.md 重新计算期望值。'})
    if static['violations']:
        findings.append({'id':'test-identification','dim':'verify','criteria':'V1','severity':'major','title':'测试可能识别被测变体','file':'tests/test_quote.py','line':static['violations'][0]['line'],'detail':'测试使用了不允许的导入、调用或私有信息。','fix':'只通过 pricing 的公开接口和规格结果验证行为。'})
    timed_out = any(run['timeout'] for run in data['reference'])
    if timed_out: findings.append({'id':'suite-timeout','dim':'verify','criteria':'V2','severity':'major','title':'测试套件超时','file':'tests/test_quote.py','line':1,'detail':'单次执行超过十秒。','fix':'缩小数据表并移除无界循环。'})
    dimensions = {dim:{'score':sum(c['score'] for c in criteria if c['dim']==dim),'max':maximum,'evaluated':True} for dim,maximum in [('verify',40),('spec',25),('code',20),('collab',15)]}
    mutants = [v for v in data['manifest'] if v['type']=='mutant']
    by_tier = {tier:{'passed':sum(v['id'] in killed for v in mutants if v['tier']==tier),'total':sum(v['tier']==tier for v in mutants)} for tier in ['basic','boundary','clarification','change']}
    diagnostics = [{'severity':'BLOCKER','code':'REQUIRED_FILE_MISSING','path':name,'message':f'缺少必交文件 {name}'} for name,text in files.items() if not text.strip()]
    if static['syntaxError']: diagnostics.append({'severity':'WARNING','code':'TEST_SYNTAX_ERROR','path':'tests/test_quote.py','message':'测试文件存在语法错误'})
    return {'total':sum(d['score'] for d in dimensions.values()),'dimensions':dimensions,'criteria':criteria,'findings':findings,'validationDiagnostics':diagnostics,
        'verifyDetail':{'validTests':valid,'invalidTests':invalid_rows,'unstableTests':data['unstable'],'defectsFound':sum(bool(ids) for ids in found.values()),'mutation':{'killed':len(killed),'total':len(mutants),'byTier':by_tier},'referenceRuns':3,'timeout':timed_out},
        'metrics':{'testMethods':static['methods'],'validTests':len(valid),'outdatedAssertions':len(data['classified']['previous']),'fixedBugAssertions':len(data['classified']['fixed']),'misreadGaps':sum(bool(ids) for ids in data['misread'].values()),'referenceMaxDurationMs':int(max((r['seconds'] for r in data['reference']),default=0)*1000)}}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',required=True); parser.add_argument('--output',required=True)
    args=parser.parse_args()
    payload=json.loads(Path(args.input).read_text(encoding='utf-8-sig'))
    started, timestamp=time.monotonic(),utc()
    scratch=Path(payload.get('scratchDir') or Path(args.output).parent)
    scratch.mkdir(parents=True,exist_ok=True)
    result=evaluate_workspace(Path(payload['workspace']),scratch=str(scratch))
    result.update(schemaVersion='1.0',resultId='result-'+hashlib.sha256((payload['submission']['snapshotHash']+payload['grading']['runId']).encode()).hexdigest()[:24],gradingRunId=payload['grading']['runId'],challengeVersion=payload['challenge']['challengeVersion'],rubricVersion=payload['challenge']['rubricVersion'],graderVersion='coupon-stacking-evaluator@1.0.0',idempotencyKey=payload['grading']['idempotencyKey'],triggerType=payload['grading']['triggerType'],status='PARTIAL' if any(d['severity']=='BLOCKER' for d in result['validationDiagnostics']) else 'COMPLETE',submission={k:v for k,v in payload['submission'].items() if k!='id'},gradedBy='ci',startedAt=timestamp,finishedAt=utc(),durationMs=int((time.monotonic()-started)*1000))
    output=Path(args.output); output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


if __name__=='__main__':
    main()
