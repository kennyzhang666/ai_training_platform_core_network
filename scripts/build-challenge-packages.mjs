#!/usr/bin/env node
/**
 * Build the distributable ZIPs for a challenge: the learner-facing challenge
 * package and the uploadable evaluation engine package.
 *
 * The challenge package must never contain hidden tests or the reference
 * solution — those are the answers. The split is enforced here rather than
 * left to whoever runs the command.
 *
 * Both archives are reproducible: identical inputs produce identical bytes.
 * `ZipFile.write` would stamp each entry with the source file's mtime, so a
 * fresh checkout alone would change the binary and dirty the working tree.
 * Text entries are normalized to LF so a CRLF checkout on Windows produces the
 * same bytes as an LF checkout on Linux.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const challengeId = process.argv[2] ?? 'log-desensitize-v1';
const source = join(root, 'challenges', challengeId);
const outputDir = join(root, 'challenge-packages', challengeId);

if (!existsSync(source)) {
  console.error(`challenge directory not found: ${relative(root, source)}`);
  process.exit(1);
}

function walk(directory) {
  if (!existsSync(join(source, directory))) return [];
  return readdirSync(join(source, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return walk(path);
    // Never ship compiled artefacts or editor droppings inside a delivery.
    if (/(?:^|\/)__pycache__\//.test(path) || /\.(?:pyc|pyo)$/.test(entry.name)) return [];
    return [path];
  });
}

/** Learner-facing package: statement, change request, contract and starter skeleton. */
const challengeEntries = [
  ['README.md', 'README.md'],
  ['change-package.md', 'change-package.md'],
  ['challenge.yaml', 'challenge.yaml'],
  ['submission-contract.json', 'submission-contract.json'],
  ...walk('starter').map((path) => [path, path]),
].filter(([from]) => existsSync(join(source, from)));

/** Uploadable engine package: manifest, judge, agent assets and frozen fixtures. */
const engineEntries = walk('engine').map((path) => [path, path.replace(/^engine\//, '')]);

const forbiddenInChallenge = /^(hidden-tests|reference|engine)\//;
for (const [from] of challengeEntries) {
  if (forbiddenInChallenge.test(from)) {
    console.error(`challenge package must not contain answers: ${from}`);
    process.exit(1);
  }
}
if (!engineEntries.some(([, to]) => to === 'engine.json')) {
  console.error('engine package is missing engine.json');
  process.exit(1);
}

const python = process.env.PYTHON
  ?? (existsSync(join(root, '.venv', 'Scripts', 'python.exe')) ? join(root, '.venv', 'Scripts', 'python.exe') : 'python');

const zipBuild = [
  'import json, pathlib, sys, zipfile',
  'payload = json.loads(sys.argv[1])',
  'root = pathlib.Path(payload["root"])',
  'output = pathlib.Path(payload["output"])',
  'output.parent.mkdir(parents=True, exist_ok=True)',
  'if output.exists(): output.unlink()',
  'EPOCH = (1980, 1, 1, 0, 0, 0)',
  'TEXT_SUFFIXES = {".md", ".json", ".yaml", ".yml", ".py", ".txt", ".cfg", ".ini"}',
  'def entry(name):',
  '    info = zipfile.ZipInfo(name, date_time=EPOCH)',
  '    info.compress_type = zipfile.ZIP_DEFLATED',
  '    info.create_system = 3',
  '    info.external_attr = 0o644 << 16',
  '    return info',
  'def payload_bytes(path):',
  '    data = path.read_bytes()',
  '    if path.suffix.lower() in TEXT_SUFFIXES:',
  '        data = data.replace(b"\\r\\n", b"\\n").replace(b"\\r", b"\\n")',
  '    return data',
  'items = sorted(payload["entries"], key=lambda item: item[1])',
  'with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:',
  '    for source_path, target in items:',
  '        archive.writestr(entry(target), payload_bytes(root / source_path))',
].join('\n');

mkdirSync(outputDir, { recursive: true });

function build(name, entries) {
  const output = join(outputDir, name);
  execFileSync(python, ['-c', zipBuild, JSON.stringify({ root: source, output, entries })],
    { encoding: 'utf8', cwd: root });
  const bytes = readFileSync(output);
  console.log(`${relative(root, output)}  ${entries.length} entries  ${bytes.length} bytes`);
}

build(`${challengeId}-challenge.zip`, challengeEntries);
build(`${challengeId}-engine.zip`, engineEntries);
