import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const extractor = join(root, 'scripts', 'safe-archive-extract.py');
const python = process.env.PYTHON ?? 'python';

function makeArchive(path, entries) {
  execFileSync(python, ['-c', [
    'import json, pathlib, sys, zipfile',
    'archive = pathlib.Path(sys.argv[1])',
    'entries = json.loads(sys.argv[2])',
    'with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as z:',
    '    for name, content in entries: z.writestr(name, content)',
  ].join('\n'), path, JSON.stringify(entries)], { windowsHide: true, stdio: 'pipe' });
}

function extract(archive, target, limits = {}) {
  return execFileSync(python, [
    extractor,
    archive,
    target,
    '--max-files', String(limits.maxFiles ?? 100),
    '--max-total-bytes', String(limits.maxTotalBytes ?? 1024 * 1024),
    '--max-file-bytes', String(limits.maxFileBytes ?? 1024 * 1024),
  ], { cwd: root, windowsHide: true, stdio: 'pipe' });
}

test('safe archive extractor materialises a valid ZIP', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'safe-extract-valid-'));
  try {
    const archive = join(sandbox, 'delivery.zip');
    const target = join(sandbox, 'workspace');
    makeArchive(archive, [['SPEC.md', '# specification'], ['src/main.py', 'print("ok")']]);
    extract(archive, target);
    assert.equal(readFileSync(join(target, 'SPEC.md'), 'utf8'), '# specification');
    assert.equal(readFileSync(join(target, 'src', 'main.py'), 'utf8'), 'print("ok")');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: 'path traversal', entries: [['../escape.txt', 'bad']], limits: {}, message: /path escapes root/i },
  { name: 'file count overflow', entries: [['a', '1'], ['b', '2']], limits: { maxFiles: 1 }, message: /file count limit/i },
  { name: 'single file overflow', entries: [['large.txt', '12345']], limits: { maxFileBytes: 4 }, message: /single file size limit/i },
  { name: 'total size overflow', entries: [['a', '123'], ['b', '456']], limits: { maxTotalBytes: 5 }, message: /total uncompressed size limit/i },
]) {
  test(`safe archive extractor rejects ${scenario.name} and leaves no partial target`, () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'safe-extract-invalid-'));
    try {
      const archive = join(sandbox, 'delivery.zip');
      const target = join(sandbox, 'workspace');
      makeArchive(archive, scenario.entries);
      assert.throws(() => extract(archive, target, scenario.limits), scenario.message);
      assert.equal(existsSync(target), false);
      assert.equal(existsSync(join(sandbox, 'escape.txt')), false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
}
