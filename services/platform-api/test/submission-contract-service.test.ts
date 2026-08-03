import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../src/artifact-store';
import { SubmissionContractService, validateSubmissionEntries } from '../src/submission-contract-service';
import { ChallengeVersion, SubmissionContractDefinition } from '../src/domain';

const projectRoot = resolve(__dirname, '..', '..', '..');
const skillsContract = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'examples', 'submission-contract.skills.valid.json'), 'utf8')) as SubmissionContractDefinition;

test('a Skills delivery contract accepts the declared tree and rejects missing or undeclared files', () => {
  const valid = validateSubmissionEntries([
    { path: 'README.md', type: 'file', size: 20 },
    { path: 'skills/log-review/SKILL.md', type: 'file', size: 200 },
    { path: 'skills/log-review/scripts/check.py', type: 'file', size: 300 },
  ], skillsContract);
  assert.equal(valid.valid, true, JSON.stringify(valid.issues));

  const missing = validateSubmissionEntries([{ path: 'README.md', type: 'file', size: 20 }], skillsContract);
  assert.equal(missing.valid, false);
  assert.ok(missing.issues.some((issue) => issue.code === 'REQUIRED_PATH_MISSING' && issue.path === 'skills/*/SKILL.md'));

  const extra = validateSubmissionEntries([
    { path: 'skills/log-review/SKILL.md', type: 'file', size: 200 },
    { path: 'notes-private.txt', type: 'file', size: 10 },
  ], skillsContract);
  assert.ok(extra.issues.some((issue) => issue.code === 'UNDECLARED_PATH' && issue.path === 'notes-private.txt'));
});

test('single-directory contracts strip the configured archive wrapper before matching', () => {
  const contract: SubmissionContractDefinition = {
    schemaVersion: '1.1',
    root: { mode: 'SINGLE_DIRECTORY', directoryName: 'delivery' },
    required: [{ path: 'skills/*/SKILL.md', type: 'markdown' }],
    forbidden: [],
  };
  const report = validateSubmissionEntries([{ path: 'delivery/skills/a/SKILL.md', type: 'file', size: 1 }], contract);
  assert.equal(report.valid, true, JSON.stringify(report.issues));
  assert.equal(report.rootPrefix, 'delivery');
  const wrongRoot = validateSubmissionEntries([{ path: 'other/skills/a/SKILL.md', type: 'file', size: 1 }], contract);
  assert.ok(wrongRoot.issues.some((issue) => issue.code === 'ROOT_DIRECTORY_NAME_INVALID'));
});

test('directory rules apply file type constraints to every descendant', () => {
  const contract: SubmissionContractDefinition = {
    schemaVersion: '1.1',
    required: [{ path: 'src', type: 'directory', minFiles: 1, allowedExtensions: ['.py'] }],
    optional: [{ path: 'docs', type: 'directory', allowedExtensions: ['.md'] }],
    forbidden: [],
    allowAdditionalPaths: false,
  };
  const report = validateSubmissionEntries([
    { path: 'src/main.txt', type: 'file', size: 1 },
    { path: 'docs/notes.txt', type: 'file', size: 1 },
  ], contract);
  assert.equal(report.valid, false);
  assert.deepEqual(report.issues.filter((issue) => issue.code === 'FILE_TYPE_INVALID').map((issue) => issue.path).sort(), ['docs/notes.txt', 'src/main.txt']);
  assert.ok(!report.issues.some((issue) => issue.code === 'UNDECLARED_PATH'));
});

test('the platform inspects an uploaded ZIP before accepting the challenge layout', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'submission-contract-'));
  const previous = { artifact: process.env.ARTIFACT_ROOT, project: process.env.PROJECT_ROOT };
  process.env.ARTIFACT_ROOT = join(sandbox, 'artifacts');
  process.env.PROJECT_ROOT = projectRoot;
  try {
    const archive = join(sandbox, 'skills.zip');
    const python = process.env.PYTHON ?? (process.platform === 'win32' ? join(projectRoot, '.venv', 'Scripts', 'python.exe') : 'python');
    execFileSync(python, ['-c', [
      'import sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1], "w") as z:',
      '    z.writestr("skills/review/SKILL.md", "# Review")',
      '    z.writestr("README.md", "delivery")',
    ].join('\n'), archive], { windowsHide: true });
    const artifacts = new ArtifactStore();
    const stored = await artifacts.saveBuffer(readFileSync(archive), 'skills.zip');
    const service = new SubmissionContractService(artifacts);
    const version = {
      id: 'skills@1', challengeId: 'skills', version: 1, title: 'Skills', zone: 'YELLOW',
      languagePolicy: {}, deliveryPolicy: {}, rubricVersion: '1.0', submissionContract: 'contracts/submission-contract-v1.1.schema.json',
      submissionContractDefinition: skillsContract, status: 'DRAFT',
    } as ChallengeVersion;
    const report = await service.validateArtifact(version, stored.uri);
    assert.equal(report?.valid, true);
    assert.equal(report?.fileCount, 2);
  } finally {
    if (previous.artifact === undefined) delete process.env.ARTIFACT_ROOT; else process.env.ARTIFACT_ROOT = previous.artifact;
    if (previous.project === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = previous.project;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
