import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../src/artifact-store';
import { computeDirectorySnapshotHash } from '../src/snapshot-hash';
import { LocalGitSnapshotter } from '../src/git-snapshotter';

test('local Git snapshot pins a branch tip and uses the same tree hash as upload mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-training-git-test-'));
  const artifactRoot = join(root, 'artifacts');
  const repositoryRoot = join(root, 'training', 'parking-fee');
  mkdirSync(join(repositoryRoot, 'src'), { recursive: true });
  writeFileSync(join(repositoryRoot, 'src', 'parking.py'), 'VALUE = 1\n', 'utf8');
  writeFileSync(join(repositoryRoot, 'README.md'), 'fixture\n', 'utf8');
  execFileSync('git', ['init', '-q', '-b', 'drill/w00124'], { cwd: repositoryRoot, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '.'], { cwd: repositoryRoot, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: repositoryRoot, windowsHide: true });

  const previousGitRoot = process.env.LOCAL_GIT_ROOT;
  const previousArtifactRoot = process.env.ARTIFACT_ROOT;
  process.env.LOCAL_GIT_ROOT = root;
  process.env.ARTIFACT_ROOT = artifactRoot;
  try {
    const artifactStore = new ArtifactStore();
    const snapshotter = new LocalGitSnapshotter(artifactStore);
    const first = await snapshotter.snapshot({ repository: 'training/parking-fee', branch: 'drill/w00124' });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(first.commitSha, commit);
    assert.equal(first.snapshotHash, computeDirectorySnapshotHash(repositoryRoot));

    writeFileSync(join(repositoryRoot, 'src', 'parking.py'), 'VALUE = 2\n', 'utf8');
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '.'], { cwd: repositoryRoot, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'moved-branch'], { cwd: repositoryRoot, windowsHide: true });
    assert.notEqual(computeDirectorySnapshotHash(repositoryRoot), first.snapshotHash);
    assert.equal((await artifactStore.snapshotHash(first.artifact.uri)), first.snapshotHash);
  } finally {
    if (previousGitRoot === undefined) delete process.env.LOCAL_GIT_ROOT; else process.env.LOCAL_GIT_ROOT = previousGitRoot;
    if (previousArtifactRoot === undefined) delete process.env.ARTIFACT_ROOT; else process.env.ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
