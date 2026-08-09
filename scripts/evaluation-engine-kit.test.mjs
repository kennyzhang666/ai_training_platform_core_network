import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'README.md');
const markdownPath = resolve(root, 'apps/web/public/evaluation-engine-development-kit.md');
const zipPath = resolve(root, 'apps/web/public/evaluation-engine-development-kit.zip');
const buildScript = resolve(root, 'scripts/build-evaluation-engine-kit.mjs');

function buildKit() {
  const result = spawnSync(process.execPath, [buildScript], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('evaluation kit ZIP is invariant to CRLF source checkouts', () => {
  const originalSource = readFileSync(sourcePath);
  const originalMarkdown = readFileSync(markdownPath);
  const originalZip = readFileSync(zipPath);
  try {
    const lfSource = Buffer.from(originalSource.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
    writeFileSync(sourcePath, lfSource);
    buildKit();
    const lfZip = readFileSync(zipPath);

    writeFileSync(sourcePath, Buffer.from(lfSource.toString('utf8').replace(/\n/g, '\r\n'), 'utf8'));
    buildKit();
    assert.deepEqual(readFileSync(zipPath), lfZip);
  } finally {
    writeFileSync(sourcePath, originalSource);
    writeFileSync(markdownPath, originalMarkdown);
    writeFileSync(zipPath, originalZip);
  }
});

test('the reference engine uses canonical Skill directories and validates offline', () => {
  const exampleRoot = resolve(root, 'tools/engine-dev-kit/examples/minimal-engine');
  const manifest = JSON.parse(readFileSync(join(exampleRoot, 'engine.json'), 'utf8'));
  assert.deepEqual(manifest.agent.skills, ['skills/evaluation']);
  const python = process.env.PYTHON ?? 'python';
  const result = spawnSync(python, [resolve(root, 'tools/engine-dev-kit/tools/engine_dev.py'), 'validate', exampleRoot], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
