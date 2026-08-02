import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException, Injectable } from '@nestjs/common';

export interface StoredArtifact {
  uri: string;
  sha256: string;
  size: number;
}

const execFileAsync = promisify(execFile);
const ZIP_SNAPSHOT = [
  'import hashlib, pathlib, stat, sys, zipfile',
  'archive = pathlib.Path(sys.argv[1])',
  'ignored_dirs = {".git", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache"}',
  'ignored_suffixes = (".pyc", ".pyo")',
  'entries = []',
  'with zipfile.ZipFile(archive) as z:',
  '    for info in z.infolist():',
  '        raw = info.filename.replace("\\\\", "/")',
  '        path = pathlib.PurePosixPath(raw)',
  '        if path.is_absolute() or ".." in path.parts: raise RuntimeError("archive path escapes workspace")',
  '        if info.is_dir() or any(part in ignored_dirs for part in path.parts) or path.suffix.lower() in ignored_suffixes: continue',
  '        mode = (info.external_attr >> 16) & 0o777',
  '        content = z.read(info)',
  '        if b"\\0" not in content:',
  '            try: content = content.decode("utf-8").replace("\\r\\n", "\\n").replace("\\r", "\\n").encode("utf-8")',
  '            except UnicodeDecodeError: pass',
  '        entries.append((path.as_posix(), hashlib.sha256(content).hexdigest(), "1" if mode & 0o111 else "0"))',
  'digest = hashlib.sha256() ',
  'for path, content_hash, executable in sorted(entries): digest.update(f"{path}\\0{content_hash}\\0{executable}\\n".encode())',
  'print(digest.hexdigest())',
].join('\n');

// The caller must be able to tell "this upload is not a ZIP archive" (a legal
// state for metadata-only local fixtures) apart from "the hasher could not
// run at all". Only the first may fall back to a plain byte hash; swallowing
// the second produced a byte hash that can never match the canonical tree hash
// of the same content delivered through Git.
const NOT_AN_ARCHIVE = 'NOT_AN_ARCHIVE';
const ZIP_SNAPSHOT_GUARDED = [
  'import zipfile',
  'def _snapshot():',
  ...ZIP_SNAPSHOT.split('\n').map((line) => `    ${line}`),
  'try:',
  '    _snapshot()',
  'except zipfile.BadZipFile:',
  `    print("${NOT_AN_ARCHIVE}")`,
].join('\n');

const ZIP_VALIDATE = [
  'import pathlib, stat, sys, zipfile',
  'archive = pathlib.Path(sys.argv[1])',
  'max_files = int(sys.argv[2])',
  'max_expanded = int(sys.argv[3])',
  'with zipfile.ZipFile(archive) as z:',
  '    infos = z.infolist()',
  '    if len(infos) > max_files: raise RuntimeError(f"archive contains too many files: {len(infos)} > {max_files}")',
  '    total = 0',
  '    for info in infos:',
  '        raw = info.filename.replace("\\\\", "/")',
  '        path = pathlib.PurePosixPath(raw)',
  '        if path.is_absolute() or ".." in path.parts: raise RuntimeError("archive path escapes workspace")',
  '        mode = (info.external_attr >> 16) & 0xffff',
  '        if stat.S_ISLNK(mode): raise RuntimeError("archive symlink is not allowed")',
  '        if info.is_dir(): continue',
  '        total += info.file_size',
  '        if total > max_expanded: raise RuntimeError(f"archive expands beyond limit: {total} > {max_expanded}")',
].join('\n');

@Injectable()
export class ArtifactStore {
  private readonly root = process.env.ARTIFACT_ROOT ?? join(existsSync(join(process.cwd(), 'grader')) ? process.cwd() : resolve(process.cwd(), '..', '..'), 'tmp', 'artifacts');
  private readonly maxBytes = Number(process.env.ARTIFACT_MAX_BYTES ?? 50 * 1024 * 1024);

  async saveBase64(encoded: string, fileName = 'submission.bin'): Promise<StoredArtifact> {
    const normalizedEncoded = encoded.replace(/\s+/g, '');
    if (!normalizedEncoded || normalizedEncoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedEncoded)) {
      throw new BadRequestException('artifactBase64 is not valid base64');
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(normalizedEncoded, 'base64');
    } catch {
      throw new BadRequestException('artifactBase64 is not valid base64');
    }
    if (!bytes.length) throw new BadRequestException('artifact is empty');
    return this.saveBuffer(bytes, fileName);
  }

  async saveBuffer(bytes: Buffer, fileName = 'submission.bin'): Promise<StoredArtifact> {
    if (!bytes.length) throw new BadRequestException('artifact is empty');
    if (bytes.length > this.maxBytes) throw new BadRequestException(`artifact exceeds ${this.maxBytes} bytes`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const safeName = basename(fileName).replace(/[^A-Za-z0-9_.-]/g, '_');
    const directory = join(this.root, sha256);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, safeName), bytes, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return { uri: `local://${sha256}/${safeName}`, sha256, size: bytes.length };
  }

  localPath(uri: string): string {
    const match = /^local:\/\/([a-f0-9]{64})\/([A-Za-z0-9_.-]+)$/.exec(uri);
    if (!match) throw new BadRequestException('artifactUri is not a local artifact URI');
    const path = join(this.root, match[1], match[2]);
    if (!existsSync(path)) throw new BadRequestException(`artifact does not exist: ${uri}`);
    return path;
  }

  /** Return the immutable byte hash recorded for a locally stored artifact. */
  async contentHash(uri: string): Promise<string> {
    return createHash('sha256').update(await readFile(this.localPath(uri))).digest('hex');
  }

  /** Read an immutable locally stored artifact for an administrator download. */
  async readBuffer(uri: string): Promise<Buffer> {
    return readFile(this.localPath(uri));
  }

  async snapshotHash(uri: string): Promise<string> {
    const path = this.localPath(uri);
    if (!path.toLowerCase().endsWith('.zip')) return createHash('sha256').update(await readFile(path)).digest('hex');
    const projectRoot = resolve(process.env.PROJECT_ROOT ?? (existsSync(join(process.cwd(), 'grader', 'run_grader.py')) ? process.cwd() : join(process.cwd(), '..', '..')));
    const python = process.env.PYTHON ?? (existsSync(join(projectRoot, '.venv', 'Scripts', 'python.exe')) ? join(projectRoot, '.venv', 'Scripts', 'python.exe') : 'python');
    let stdout: string;
    try {
      const result = await execFileAsync(python, ['-c', ZIP_SNAPSHOT_GUARDED, path], {
        cwd: projectRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      });
      stdout = result.stdout.trim();
    } catch (error) {
      const details = error as { stderr?: string; message?: string };
      throw new BadRequestException({
        code: 'SNAPSHOT_HASHER_UNAVAILABLE',
        message: `无法计算交付件内容哈希: ${(details.stderr ?? details.message ?? '').trim().slice(-500)}`,
      });
    }
    if (stdout.endsWith(NOT_AN_ARCHIVE)) {
      // A metadata-only or deliberately malformed local fixture still gets a
      // stable byte hash; the executor surfaces the extraction error when
      // grading is actually requested.
      return createHash('sha256').update(await readFile(path)).digest('hex');
    }
    if (!/^[a-f0-9]{64}$/.test(stdout)) {
      throw new BadRequestException({ code: 'SNAPSHOT_HASHER_UNAVAILABLE', message: '内容哈希计算返回了非预期结果' });
    }
    return stdout;
  }

  /** Validate an uploaded ZIP before it enters an evaluation queue. */
  async validateArchive(uri: string, maxFiles = 2000, maxExpandedBytes = 100 * 1024 * 1024): Promise<void> {
    const path = this.localPath(uri);
    if (!path.toLowerCase().endsWith('.zip')) return;
    const projectRoot = resolve(process.env.PROJECT_ROOT ?? (existsSync(join(process.cwd(), 'grader', 'run_grader.py')) ? process.cwd() : join(process.cwd(), '..', '..')));
    const python = process.env.PYTHON ?? (existsSync(join(projectRoot, '.venv', 'Scripts', 'python.exe')) ? join(projectRoot, '.venv', 'Scripts', 'python.exe') : 'python');
    try {
      await execFileAsync(python, ['-c', ZIP_VALIDATE, path, String(Math.max(1, maxFiles)), String(Math.max(1, maxExpandedBytes))], {
        cwd: projectRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      });
    } catch {
      throw new BadRequestException({ code: 'ARTIFACT_ARCHIVE_INVALID', message: '交付压缩包校验未通过' });
    }
  }
}
