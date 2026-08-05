#!/usr/bin/env node
/**
 * Build the self-contained Markdown handoff used by the admin environment page.
 *
 * The bundle intentionally contains only development guidance, contracts,
 * examples and reference implementation files. It must never include tmp/,
 * .env files, credentials or runtime logs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'apps', 'web', 'public', 'evaluation-engine-development-kit.md');
const zipOutput = join(root, 'apps', 'web', 'public', 'evaluation-engine-development-kit.zip');

// The bundle version must follow the release, not a literal that silently goes
// stale one version after somebody edits it.
const kitVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const explicitFiles = [
  'AGENTS.md',
  'README.md',
  'DEVELOPMENT_PLAN.md',
  'package.json',
  'pnpm-workspace.yaml',
  'docs/evaluation-engine-protocol.md',
  'docs/evaluation-contract-authoring.md',
  'docs/submission-contract.md',
  'docs/v0.7-development-manual.md',
  'docs/v0.8-development-manual.md',
  'docs/deployment/trusted-gateway-sso.md',
  'scripts/evaluation-worker.mjs',
  'scripts/code-agent-local-bridge.mjs',
  'scripts/build-engine-package.mjs',
  'executors/drill-grader/engine.json',
  'executors/drill-grader/instruction.md',
  'executors/drill-grader/judge.py',
  'executors/drill-grader/skills/evaluation/SKILL.md',
  'grader/SKILL.md',
  'grader/requirements.txt',
];

function walk(directory) {
  const entries = readdirSync(join(root, directory), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(json|yaml|yml|md|py|txt)$/.test(entry.name) ? [path] : [];
  });
}

const files = [...new Set([
  ...explicitFiles,
  ...walk('contracts'),
  ...walk('grader/references'),
  ...walk('tools/engine-dev-kit'),
])].filter((path) => existsSync(join(root, path))).sort();

const guideSource = readFileSync(join(root, 'apps', 'web', 'src', 'evaluation-engine-guide.ts'), 'utf8');
const guideMatch = guideSource.match(/String\.raw`([\s\S]*)`;/);
const guide = guideMatch?.[1]?.replace(/^\n/, '') ?? '# 评测引擎开发指南\n';

const sections = files.map((path) => {
  const normalized = path.replaceAll('\\', '/');
  const contents = readFileSync(join(root, path), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd();
  return `\n--- BEGIN FILE: ${normalized} ---\n\n${contents}\n\n--- END FILE: ${normalized} ---\n`;
}).join('\n');

const outputText = [
  '# AI 评测引擎开发资料包',
  '',
  `> 版本：${kitVersion}。此文件是自包含的开发上下文，不是可直接运行的源码仓库。它嵌入了指南、真实契约、样例和参考实现；要运行测试，仍需取得项目源码并按 README 配置环境。`,
  '',
  '## 使用方式',
  '',
  '1. 先阅读下方的评测引擎开发指南。',
  '2. 按 BEGIN FILE / END FILE 标记把需要的内容还原成对应路径；AI 也可以直接把整个文件作为上下文阅读。',
  '3. 以 contracts/ 中的已发布 Schema 为事实来源，不要根据示例臆造字段。',
  '4. 真正执行 pnpm、Python grader 或 Worker 测试时，必须在完整项目源码目录中运行。',
  '',
  '## 评测引擎开发指南',
  '',
  guide.trimEnd(),
  '',
  '## 嵌入的仓库文件',
  '',
  `共 ${files.length} 个文件，按仓库相对路径嵌入。`,
  sections,
  '',
].join('\n');

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${outputText.trimEnd()}\n`, 'utf8');

const standaloneRoot = 'tools/engine-dev-kit';
const zipEntries = [
  ...files
    .filter((path) => {
      const normalized = path.replaceAll('\\', '/');
      return normalized === 'AGENTS.md' || normalized === 'README.md' || normalized === 'DEVELOPMENT_PLAN.md' || normalized === 'package.json' || normalized === 'pnpm-workspace.yaml' || normalized.startsWith('contracts/') || normalized.startsWith('docs/') || normalized.startsWith('scripts/') || normalized.startsWith('executors/') || normalized.startsWith('grader/');
    })
    .map((path) => {
      const normalized = path.replaceAll('\\', '/');
      return { source: path, target: (normalized.startsWith('contracts/') || normalized.startsWith('docs/')) ? normalized : `reference/platform/${normalized}` };
    }),
  ...files
    .filter((path) => path.replaceAll('\\', '/').startsWith(`${standaloneRoot}/`))
    .map((path) => ({ source: path, target: relative(standaloneRoot, path).replaceAll('\\', '/') })),
];

const python = process.env.PYTHON ?? (existsSync(join(root, '.venv', 'Scripts', 'python.exe')) ? join(root, '.venv', 'Scripts', 'python.exe') : 'python');
// The archive must be reproducible: identical inputs have to produce identical
// bytes. `ZipFile.write` stamps each entry with the source file's mtime and
// `writestr` stamps GUIDE.md with the current time, so every build produced a
// new binary and dirtied the working tree even when nothing had changed.
// Pin the DOS epoch, a fixed mode and a fixed entry order instead.
const zipBuild = [
  'import json, pathlib, sys, zipfile',
  'payload = json.loads(sys.argv[1])',
  'root = pathlib.Path(payload["root"])',
  'output = pathlib.Path(payload["output"])',
  'output.parent.mkdir(parents=True, exist_ok=True)',
  'if output.exists(): output.unlink()',
  'EPOCH = (1980, 1, 1, 0, 0, 0)',
  'def entry(name):',
  '    info = zipfile.ZipInfo(name, date_time=EPOCH)',
  '    info.compress_type = zipfile.ZIP_DEFLATED',
  '    info.create_system = 3',
  '    info.external_attr = 0o644 << 16',
  '    return info',
  'items = sorted(payload["entries"], key=lambda item: item["target"])',
  'with zipfile.ZipFile(output, "w") as archive:',
  '    for item in items:',
  '        archive.writestr(entry(item["target"]), (root / item["source"]).read_bytes())',
  '    archive.writestr(entry("GUIDE.md"), payload["guide"].encode("utf-8") + b"\\n")',
].join('\n');
execFileSync(python, ['-c', zipBuild, JSON.stringify({ root, output: zipOutput, entries: zipEntries, guide })], { encoding: 'utf8', cwd: root });
console.log(`evaluation engine kit: ${relative(root, output)}`);
console.log(`evaluation engine kit zip: ${relative(root, zipOutput)}`);
