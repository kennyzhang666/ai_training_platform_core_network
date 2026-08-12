import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const version = args.get('--version') ?? JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid hotfix version: ${version}`);
const releaseRoot = resolve(args.get('--output-root') ?? join(root, 'release'));
const directory = join(releaseRoot, `ai-training-platform-${version}-hotfix-linux-x64`);
const archive = `${directory}.tar.gz`;

await rm(directory, { recursive: true, force: true });
await rm(archive, { force: true });
await rm(`${archive}.sha256`, { force: true });
await mkdir(join(directory, 'payload', 'services', 'platform-api'), { recursive: true });
await mkdir(join(directory, 'payload', 'apps', 'web'), { recursive: true });
await cp(join(root, 'services', 'platform-api', 'dist'), join(directory, 'payload', 'services', 'platform-api', 'dist'), { recursive: true });
await cp(join(root, 'apps', 'web', 'dist'), join(directory, 'payload', 'apps', 'web', 'dist'), { recursive: true });

for (const name of ['apply-hotfix.sh', 'HOTFIX_GUIDE.md']) {
  const source = await readFile(join(root, 'deploy', 'hotfix', name), 'utf8');
  await writeFile(join(directory, name), source.replaceAll('@@VERSION@@', version), { encoding: 'utf8', mode: name.endsWith('.sh') ? 0o755 : 0o644 });
}

async function filesBelow(base, current = base) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = join(current, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(base, target));
    else if (entry.isFile()) output.push(relative(base, target).split(sep).join('/'));
  }
  return output;
}

const payloadFiles = (await filesBelow(directory)).filter((name) => name !== 'SHA256SUMS').sort();
const checksums = [];
for (const name of payloadFiles) {
  const bytes = await readFile(join(directory, ...name.split('/')));
  checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await writeFile(join(directory, 'SHA256SUMS'), `${checksums.join('\n')}\n`, 'utf8');

const python = process.platform === 'win32' ? 'python' : 'python3';
const packed = spawnSync(python, [join(root, 'scripts', 'archive-hotfix.py'), directory, archive], { cwd: root, stdio: 'inherit' });
if (packed.status !== 0) throw new Error('hotfix archive creation failed');
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`, 'utf8');
process.stdout.write(`hotfix directory: ${directory}\nhotfix archive: ${archive}\nsha256: ${digest}\n`);
