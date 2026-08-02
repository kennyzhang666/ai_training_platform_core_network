import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { computeDirectorySnapshotHash } from '../src/snapshot-hash';

const projectRoot = resolve(__dirname, '..', '..', '..');

function python(): string {
  const venv = join(projectRoot, '.venv', 'Scripts', 'python.exe');
  return process.env.PYTHON ?? (existsSync(venv) ? venv : 'python');
}

function graderSnapshotHash(directory: string): string {
  const output = execFileSync(python(), [
    '-c',
    [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(join(projectRoot, 'grader', 'src'))})`,
      'from pathlib import Path',
      'from drill_grader.snapshot import snapshot_hash',
      'print(snapshot_hash(Path(sys.argv[1])))',
    ].join('\n'),
    directory,
  ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  return output.trim();
}

// The platform hashes a working directory in TypeScript while the grader and
// the ZIP hasher do it in Python. Both walk the tree in sorted order, so the
// comparator has to agree: `localeCompare` treats `_` as ignorable and sorts
// lower case first, which silently produced two different hashes for the same
// content as soon as a submission contained, say, `__init__.py`.
test('the TypeScript tree hash matches the Python grader for order-sensitive names', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-training-snapshot-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'SPEC.md'), '# 规格\n', 'utf8');
    writeFileSync(join(root, 'NOTES.md'), 'notes\n', 'utf8');
    writeFileSync(join(root, '__init__.py'), '', 'utf8');
    writeFileSync(join(root, '_helpers.py'), 'HELPER = 1\n', 'utf8');
    writeFileSync(join(root, 'a-b.py'), 'AB = 1\n', 'utf8');
    writeFileSync(join(root, 'ab.py'), 'AB = 2\n', 'utf8');
    writeFileSync(join(root, 'src', '__init__.py'), '', 'utf8');
    writeFileSync(join(root, 'src', 'parking.py'), 'RATE = 8\n', 'utf8');

    assert.equal(computeDirectorySnapshotHash(root), graderSnapshotHash(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the tree hash ignores line endings but not content or layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-training-snapshot-'));
  try {
    writeFileSync(join(root, 'a.py'), 'X = 1\nY = 2\n', 'utf8');
    const unix = computeDirectorySnapshotHash(root);
    writeFileSync(join(root, 'a.py'), 'X = 1\r\nY = 2\r\n', 'utf8');
    assert.equal(computeDirectorySnapshotHash(root), unix);
    writeFileSync(join(root, 'a.py'), 'X = 1\nY = 3\n', 'utf8');
    assert.notEqual(computeDirectorySnapshotHash(root), unix);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
