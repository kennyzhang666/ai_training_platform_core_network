#!/usr/bin/env node
/**
 * Build an evaluation engine package (zip) from a challenge's engine source.
 *
 * The package is what an author uploads: judge script, hidden tests and the
 * submission contract frozen together. Keeping the assets in the challenge
 * directory avoids duplicating them in the repository, while the produced zip
 * stays fully self-contained.
 *
 *   node scripts/build-engine-package.mjs parking-fee-v1 [--out tmp/engine.zip]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [challengeName, ...rest] = process.argv.slice(2);
if (!challengeName) {
  console.error('usage: node scripts/build-engine-package.mjs <challenge-dir> [--out <zip>]');
  process.exit(2);
}
const outIndex = rest.indexOf('--out');
const output = resolve(root, outIndex >= 0 ? rest[outIndex + 1] : join('tmp', `${challengeName}-engine.zip`));
const challengeRoot = join(root, 'challenges', challengeName);
const engineRoot = join(challengeRoot, 'engine');
if (!existsSync(join(engineRoot, 'engine.json'))) {
  console.error(`missing ${join(engineRoot, 'engine.json')}`);
  process.exit(2);
}

// Copy the engine sources plus the assets engine.json points at, then zip.
const build = [
  'import json, pathlib, shutil, sys, tempfile, zipfile',
  'engine_root, challenge_root, output = (pathlib.Path(p) for p in sys.argv[1:4])',
  'manifest = json.loads((engine_root / "engine.json").read_text(encoding="utf-8"))',
  'assets = manifest.get("assets", {})',
  'sources = {',
  '    "assets/submission-contract.json": challenge_root / "submission-contract.json",',
  '    "assets/hidden-tests": challenge_root / "hidden-tests",',
  '    "assets/reference": challenge_root / "reference",',
  '}',
  'with tempfile.TemporaryDirectory() as tmp:',
  '    staging = pathlib.Path(tmp) / "package"',
  '    shutil.copytree(engine_root, staging)',
  '    for declared in assets.values():',
  '        source = sources.get(declared)',
  '        if source is None: raise SystemExit(f"engine.json declares an asset this builder does not know: {declared}")',
  '        if not source.exists(): raise SystemExit(f"missing asset source: {source}")',
  '        target = staging / declared',
  '        target.parent.mkdir(parents=True, exist_ok=True)',
  '        shutil.copytree(source, target) if source.is_dir() else shutil.copyfile(source, target)',
  '    output.parent.mkdir(parents=True, exist_ok=True)',
  '    if output.exists(): output.unlink()',
  '    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:',
  '        for path in sorted(p for p in staging.rglob("*") if p.is_file() and "__pycache__" not in p.parts):',
  '            archive.write(path, path.relative_to(staging).as_posix())',
  'print(output)',
].join('\n');

const python = process.env.PYTHON ?? (existsSync(join(root, '.venv', 'Scripts', 'python.exe')) ? join(root, '.venv', 'Scripts', 'python.exe') : 'python');
mkdirSync(dirname(output), { recursive: true });
const built = execFileSync(python, ['-c', build, engineRoot, challengeRoot, output], { encoding: 'utf8', cwd: root });
console.log(`engine package: ${built.trim()}`);
