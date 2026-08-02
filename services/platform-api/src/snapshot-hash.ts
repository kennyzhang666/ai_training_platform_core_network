import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const IGNORED_DIRS = new Set(['.git', '.venv', '__pycache__', '.mypy_cache', '.pytest_cache']);
const IGNORED_SUFFIXES = new Set(['.pyc', '.pyo']);

/**
 * Order paths by UTF-16 code point, which is what Python's `sorted()` produces
 * for the same strings. `localeCompare` is locale-aware (it ignores `_`/`-` at
 * the primary level and sorts lower case before upper case), so using it here
 * makes this hasher disagree with the Python grader and the ZIP hasher for any
 * tree that mixes, for example, `__init__.py` with `SPEC.md`.
 */
function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function files(root: string): Array<{ path: string; absolute: string }> {
  const result: Array<{ path: string; absolute: string }> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name))) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute).split('\\').join('/');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && ![...IGNORED_SUFFIXES].some((suffix) => entry.name.toLowerCase().endsWith(suffix))) result.push({ path: relativePath, absolute });
      else if (entry.isSymbolicLink()) throw new Error(`snapshot cannot include symbolic link: ${relativePath}`);
    }
  };
  walk(root);
  return result.sort((a, b) => byCodePoint(a.path, b.path));
}

function canonicalBytes(value: Buffer): Buffer {
  if (value.includes(0)) return value;
  const text = value.toString('utf8');
  // If the round-trip changes bytes, treat the file as binary rather than
  // normalizing an arbitrary encoding.
  if (!Buffer.from(text, 'utf8').equals(value)) return value;
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}

export function computeDirectorySnapshotHash(value: string): string {
  const root = realpathSync(resolve(value));
  const digest = createHash('sha256');
  for (const entry of files(root)) {
    const stat = lstatSync(entry.absolute);
    const contentHash = createHash('sha256').update(canonicalBytes(readFileSync(entry.absolute))).digest('hex');
    const executable = stat.mode & 0o111 ? '1' : '0';
    digest.update(`${entry.path}\0${contentHash}\0${executable}\n`, 'utf8');
  }
  return digest.digest('hex');
}
