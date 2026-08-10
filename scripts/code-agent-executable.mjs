import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

function commandNames(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  const name = basename(normalized);
  const withoutNativeExtension = name.replace(/\.(?:exe|com|cmd|bat|ps1)$/i, '');
  return new Set([normalized, name, withoutNativeExtension].filter(Boolean));
}

export function executableIsAllowed(executable, allowed) {
  if (!allowed.length) return true;
  const candidates = commandNames(executable);
  return allowed.some((entry) => {
    const permitted = commandNames(entry);
    return [...candidates].some((value) => permitted.has(value));
  });
}

function defaultLookup(command, platform) {
  if (platform === 'win32') {
    try {
      return execFileSync('where.exe', [command], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  return [];
}

function nativeFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function executableFile(path, platform) {
  if (!nativeFile(path)) return false;
  if (platform === 'win32') return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveNpmNativeShim(shim) {
  const content = readFileSync(shim, 'utf8');
  const shimRoot = `${dirname(shim)}${sep}`;
  for (const rawLine of content.split(/\r?\n/)) {
    const match = /^\s*"([^"]+\.(?:exe|com))"\s+%\*\s*$/i.exec(rawLine);
    if (!match) continue;
    const expanded = match[1]
      .replace(/%~dp0/gi, shimRoot)
      .replace(/%dp0%/gi, shimRoot);
    if (/%[^%]+%/.test(expanded)) continue;
    const candidate = resolve(expanded);
    if (nativeFile(candidate)) return candidate;
  }
  throw new Error(`Windows 命令包装器没有可安全启动的原生可执行文件：${shim}`);
}

/**
 * Resolve a Code Agent command without ever enabling a command shell.
 * Windows npm packages commonly put only .cmd/.ps1 wrappers on PATH; when a
 * generated .cmd delegates directly to a native .exe, resolve that target and
 * launch it with spawn(..., { shell: false }). Other wrappers are rejected.
 */
export function resolveSpawnExecutable(configured, options = {}) {
  const command = String(configured ?? '').trim();
  if (!command || /[\u0000\r\n]/.test(command)) throw new Error('Code Agent 可执行文件配置为空或包含换行');
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const lookup = options.lookup ?? ((value) => defaultLookup(value, platform));
  const hasPath = isAbsolute(command) || /[\\/]/.test(command);
  const candidates = hasPath
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : platform === 'win32'
      ? lookup(command)
      : String(options.path ?? process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const rawCandidate of candidates) {
    const candidate = resolve(rawCandidate);
    if (!existsSync(candidate)) continue;
    if (platform !== 'win32') {
      if (executableFile(candidate, platform)) return candidate;
      continue;
    }
    const extension = extname(candidate).toLowerCase();
    if ((extension === '.exe' || extension === '.com') && nativeFile(candidate)) return candidate;
    if (extension === '.cmd' || extension === '.bat') {
      try { return resolveNpmNativeShim(candidate); } catch { continue; }
    }
  }
  if (platform === 'win32') {
    throw new Error(`无法为 Code Agent 找到原生可执行文件：${command}。PowerShell 脚本和普通批处理不能由 Worker 直接执行。`);
  }
  throw new Error(`找不到 Code Agent 可执行文件：${command}`);
}
