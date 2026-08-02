import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const candidates = process.platform === 'win32'
  ? [join(root, '.venv', 'Scripts', 'python.exe'), 'python']
  : [join(root, '.venv', 'bin', 'python'), 'python3', 'python'];
const python = candidates.find((candidate) => candidate === 'python' || candidate === 'python3' || existsSync(candidate));
if (!python) {
  console.error('Python runtime not found. Create .venv and install grader/requirements.txt.');
  process.exit(2);
}
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'grader/tests', '-v'], { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(2);
}
process.exit(result.status ?? 1);
