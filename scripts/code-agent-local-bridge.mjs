#!/usr/bin/env node
/**
 * Local contract adapter for end-to-end development only.
 *
 * Production sets CODE_AGENT_COMMAND to the organization's Code Agent bridge.
 * This adapter proves the same batch ABI locally by reading the instruction and
 * skills, then invoking the frozen deterministic engine once per submission.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const manifestIndex = args.indexOf('--manifest');
const manifestPath = manifestIndex >= 0 ? resolve(args[manifestIndex + 1] ?? '') : resolve(process.env.AI_TRAINING_BATCH_MANIFEST ?? '');
if (!manifestPath || !existsSync(manifestPath)) throw new Error('缺少 --manifest <batch-manifest.json>');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!['1.0', '1.1'].includes(manifest.schemaVersion)) throw new Error('不支持的批次清单版本');

// Loading these files is part of the bridge ABI. A real Code Agent bridge adds
// their contents to the agent context; this deterministic adapter only checks
// that the frozen assets are present and readable.
readFileSync(manifest.agent.instructionPath, 'utf8');
for (const skillPath of manifest.agent.skillPaths) {
  const skillFile = statSync(skillPath).isDirectory() ? join(skillPath, 'SKILL.md') : skillPath;
  if (basename(skillFile) !== 'SKILL.md') throw new Error(`Skill 路径必须指向目录或 SKILL.md：${skillPath}`);
  readFileSync(skillFile, 'utf8');
}

const python = process.env.AI_TRAINING_ENGINE_PYTHON ?? process.env.PYTHON ?? (existsSync(join(root, '.venv', 'Scripts', 'python.exe')) ? join(root, '.venv', 'Scripts', 'python.exe') : 'python');
const launcher = join(root, 'sandbox', 'launch.py');
const results = [];
const failures = [];
for (const item of manifest.submissions) {
  try {
    const inputPath = join(dirname(item.outputPath), `${item.runId}.input.json`);
    writeFileSync(inputPath, JSON.stringify({
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      engine: {
        id: manifest.engine.id,
        version: manifest.engine.version,
        source: manifest.engine.source,
        packageHash: manifest.engine.packageHash,
        packageRoot: manifest.engine.root,
        assets: manifest.engine.assets,
      },
      challenge: manifest.challenge,
      grading: { runId: item.runId, idempotencyKey: item.idempotencyKey, triggerType: item.triggerType, attempt: item.attempt },
      subject: item.subject,
      submission: item.submission,
      workspace: item.workspace,
      outputPath: item.outputPath,
      scratchDir: item.scratchDir,
      limits: manifest.engine.limits,
      params: manifest.engine.params,
    }, null, 2), 'utf8');
    execFileSync(python, [
      launcher,
      '--entry', manifest.engine.entrypoint,
      '--input', inputPath,
      '--output', item.outputPath,
      '--cwd', item.scratchDir,
      '--python', python,
      '--memory-mb', String(manifest.engine.limits.memoryMB),
      '--cpu-seconds', String(manifest.engine.limits.wallClockSeconds),
      '--wall-seconds', String(manifest.engine.limits.wallClockSeconds),
      '--output-bytes', String(manifest.engine.limits.outputBytes),
    ], { cwd: root, windowsHide: true, stdio: 'pipe' });
    results.push({ runId: item.runId, result: JSON.parse(readFileSync(item.outputPath, 'utf8')) });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    failures.push({ runId: item.runId, reason: details.slice(-2000) });
  }
}
writeFileSync(manifest.resultIndexPath, JSON.stringify({ schemaVersion: '1.0', batchId: manifest.batch.id, results, failures }, null, 2), 'utf8');
