import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ArtifactStore, StoredArtifact } from './artifact-store';

const execFileAsync = promisify(execFile);

export interface GitSnapshotInput {
  repository: string;
  branch: string;
  commitSha?: string;
}

export interface GitSnapshotResult {
  commitSha: string;
  artifact: StoredArtifact;
  snapshotHash: string;
}

/**
 * Local-only Git adapter used for deterministic development and CI fixtures.
 * GitLab remains a separate executor integration; this adapter never accepts
 * arbitrary remote URLs and only reads repositories below LOCAL_GIT_ROOT.
 */
@Injectable()
export class LocalGitSnapshotter {
  private readonly gitRoot = process.env.LOCAL_GIT_ROOT ? resolve(process.env.LOCAL_GIT_ROOT) : undefined;
  private readonly timeout = Number(process.env.GIT_COMMAND_TIMEOUT_MS ?? 30_000);

  constructor(private readonly artifacts: ArtifactStore) {}

  get enabled(): boolean {
    return Boolean(this.gitRoot);
  }

  private repositoryPath(repository: string): string {
    if (!this.gitRoot) throw new BadRequestException('LOCAL_GIT_ROOT is not configured for local Git snapshots');
    if (!repository || repository.includes('\0') || repository.includes('://') || /^[A-Za-z]:[\\/]/.test(repository)) {
      throw new BadRequestException('local repository must be a relative path below LOCAL_GIT_ROOT');
    }
    const target = resolve(this.gitRoot, repository.replace(/[\\]/g, sep));
    if (!existsSync(target)) throw new BadRequestException(`local repository does not exist: ${repository}`);
    const realRoot = realpathSync(this.gitRoot);
    const realTarget = realpathSync(target);
    const relativePath = relative(realRoot, realTarget);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.includes(`..${sep}`)) {
      throw new BadRequestException('local repository must stay inside LOCAL_GIT_ROOT');
    }
    const isWorktree = existsSync(join(realTarget, '.git'));
    const isBareRepository = existsSync(join(realTarget, 'HEAD')) && existsSync(join(realTarget, 'objects')) && existsSync(join(realTarget, 'refs'));
    if (!isWorktree && !isBareRepository) throw new BadRequestException(`local repository is not a Git repository: ${repository}`);
    return realTarget;
  }

  private async git(repository: string, args: string[]): Promise<string> {
    try {
      const result = await execFileAsync('git', ['-C', repository, ...args], {
        cwd: this.gitRoot,
        timeout: this.timeout,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return result.stdout.trim();
    } catch (error) {
      const details = error as { stderr?: string; message?: string };
      throw new BadRequestException(`local Git command failed: ${(details.stderr ?? details.message ?? '').trim().slice(-1000)}`);
    }
  }

  async snapshot(input: GitSnapshotInput): Promise<GitSnapshotResult> {
    const repository = this.repositoryPath(input.repository);
    if (!/^[A-Za-z0-9._/-]+$/.test(input.branch) || input.branch.startsWith('/') || input.branch.endsWith('/') || input.branch.includes('..')) {
      throw new BadRequestException('branch contains unsupported path characters');
    }
    if (input.commitSha && !/^[a-f0-9]{7,64}$/.test(input.commitSha)) throw new BadRequestException('commitSha must be a lowercase hexadecimal SHA');
    const commitSha = await this.git(repository, ['rev-parse', '--verify', input.commitSha ? `${input.commitSha}^{commit}` : `refs/heads/${input.branch}^{commit}`]);
    const branchSha = await this.git(repository, ['rev-parse', '--verify', `refs/heads/${input.branch}^{commit}`]);
    if (input.commitSha && commitSha !== branchSha) throw new BadRequestException('commitSha is not the current tip of the requested branch');

    const temporary = await mkdtemp(join(tmpdir(), 'ai-training-git-'));
    const archive = join(temporary, `${basename(input.repository)}.zip`);
    try {
      await this.git(repository, ['archive', '--format=zip', '--output', archive, commitSha]);
      const bytes = await readFile(archive);
      const artifact = await this.artifacts.saveBuffer(bytes, 'git-snapshot.zip');
      const snapshotHash = await this.artifacts.snapshotHash(artifact.uri);
      return { commitSha, artifact, snapshotHash };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
