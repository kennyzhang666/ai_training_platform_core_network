import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { ArtifactEntry, ArtifactStore } from './artifact-store';
import { ChallengeVersion, SubmissionContractDefinition, SubmissionContractItem } from './domain';

export interface SubmissionContractIssue {
  code: string;
  path?: string;
  message: string;
}

export interface SubmissionContractReport {
  valid: boolean;
  schemaVersion: string;
  rootPrefix?: string;
  fileCount: number;
  issues: SubmissionContractIssue[];
}

function projectRoot(): string {
  const cwd = process.cwd();
  return resolve(process.env.PROJECT_ROOT ?? (existsSync(join(cwd, 'grader', 'run_grader.py')) ? cwd : join(cwd, '..', '..')));
}

function assertRepositoryPath(value: string): void {
  if (!value?.trim() || value.includes('..') || value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) {
    throw new BadRequestException({ code: 'SUBMISSION_CONTRACT_PATH_INVALID', message: '交付目录规范路径必须位于平台仓库内' });
  }
}

function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function matches(path: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  return globRegex(normalizedPattern).test(path);
}

function extensionAllowed(path: string, item: SubmissionContractItem): boolean {
  if (item.allowedExtensions?.length) {
    const extension = extname(path).toLowerCase();
    if (!item.allowedExtensions.some((value) => value.toLowerCase() === extension)) return false;
  }
  if (item.type === 'markdown' && !/\.md(?:own)?$/i.test(path)) return false;
  if (item.type === 'json' && !/\.json$/i.test(path)) return false;
  if (item.type === 'yaml' && !/\.ya?ml$/i.test(path)) return false;
  return true;
}

function normalizeEntries(rawEntries: ArtifactEntry[], contract: SubmissionContractDefinition): { entries: ArtifactEntry[]; rootPrefix?: string; issues: SubmissionContractIssue[] } {
  const issues: SubmissionContractIssue[] = [];
  const unique = new Map<string, ArtifactEntry>();
  for (const item of rawEntries) {
    const path = item.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
    if (!path) continue;
    const existing = unique.get(path);
    if (existing?.type === 'file' || (existing && existing.type !== item.type)) {
      issues.push({ code: 'DUPLICATE_PATH', path, message: `交付件包含重复路径：${path}` });
    }
    unique.set(path, { path, type: item.type, size: Math.max(0, Number(item.size ?? 0)) });
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (!unique.has(parent)) unique.set(parent, { path: parent, type: 'directory', size: 0 });
    }
  }
  let entries = [...unique.values()];
  let rootPrefix: string | undefined;
  if (contract.root?.mode === 'SINGLE_DIRECTORY') {
    const files = entries.filter((item) => item.type === 'file');
    const roots = new Set(entries.map((item) => item.path.split('/')[0]));
    if (!files.length || roots.size !== 1 || files.some((item) => !item.path.includes('/'))) {
      issues.push({ code: 'ROOT_DIRECTORY_REQUIRED', message: '交付包必须只包含一个顶层目录，所有文件均放在该目录内' });
      return { entries, issues };
    }
    rootPrefix = [...roots][0];
    if (contract.root.directoryName && rootPrefix !== contract.root.directoryName) {
      issues.push({ code: 'ROOT_DIRECTORY_NAME_INVALID', path: rootPrefix, message: `顶层目录必须命名为 ${contract.root.directoryName}` });
    }
    entries = entries
      .filter((item) => item.path !== rootPrefix)
      .map((item) => ({ ...item, path: item.path.slice(rootPrefix!.length + 1) }))
      .filter((item) => item.path);
  }
  return { entries, rootPrefix, issues };
}

/** Pure layout validation, shared by API upload and tests. */
export function validateSubmissionEntries(rawEntries: ArtifactEntry[], contract: SubmissionContractDefinition): SubmissionContractReport {
  const normalized = normalizeEntries(rawEntries, contract);
  const issues = [...normalized.issues];
  const entries = normalized.entries;
  const files = entries.filter((item) => item.type === 'file');
  const directories = entries.filter((item) => item.type === 'directory');

  if (contract.maxFiles && files.length > contract.maxFiles) {
    issues.push({ code: 'TOO_MANY_FILES', message: `交付件包含 ${files.length} 个文件，最多允许 ${contract.maxFiles} 个` });
  }
  if (contract.maxDepth) {
    const deepest = entries.reduce((max, item) => Math.max(max, item.path.split('/').length), 0);
    if (deepest > contract.maxDepth) issues.push({ code: 'DIRECTORY_TOO_DEEP', message: `交付目录深度为 ${deepest}，最多允许 ${contract.maxDepth} 层` });
  }

  const validateRule = (rule: SubmissionContractItem, required: boolean): void => {
    const candidates = rule.type === 'directory' ? directories : files;
    const matched = candidates.filter((item) => matches(item.path, rule.path));
    if (!matched.length) {
      if (required) issues.push({ code: 'REQUIRED_PATH_MISSING', path: rule.path, message: `缺少必需的${rule.type === 'directory' ? '目录' : '文件'}：${rule.path}` });
      return;
    }
    const matchedFiles = rule.type === 'directory'
      ? files.filter((file) => matched.some((directory) => file.path.startsWith(`${directory.path}/`)))
      : matched;
    if (rule.type === 'directory' && rule.minFiles) {
      if (matchedFiles.length < rule.minFiles) issues.push({ code: 'DIRECTORY_FILE_COUNT_LOW', path: rule.path, message: `${rule.path} 至少需要包含 ${rule.minFiles} 个文件` });
    } else if (rule.minFiles && matched.length < rule.minFiles) {
      issues.push({ code: 'MATCHED_FILE_COUNT_LOW', path: rule.path, message: `${rule.path} 至少需要匹配 ${rule.minFiles} 个文件` });
    }
    for (const file of matchedFiles) {
      if (!extensionAllowed(file.path, rule)) {
        issues.push({ code: 'FILE_TYPE_INVALID', path: file.path, message: `${file.path} 的文件类型不符合交付规范` });
      }
    }
  };

  for (const rule of contract.required) validateRule(rule, true);
  for (const rule of contract.optional ?? []) validateRule(rule, false);

  for (const [language, entry] of Object.entries(contract.languageEntry ?? {})) {
    if (entry && !files.some((file) => matches(file.path, entry))) {
      issues.push({ code: 'LANGUAGE_ENTRY_MISSING', path: entry, message: `缺少 ${language} 入口文件：${entry}` });
    }
  }

  for (const pattern of contract.forbidden) {
    for (const entry of entries.filter((item) => matches(item.path, pattern))) {
      issues.push({ code: 'FORBIDDEN_PATH', path: entry.path, message: `交付件包含禁止内容：${entry.path}` });
    }
  }

  if (contract.allowAdditionalPaths === false) {
    const allowedPatterns = [
      ...(contract.allowedPaths ?? []),
      ...contract.required.filter((item) => item.type !== 'directory').map((item) => item.path),
      ...contract.required.filter((item) => item.type === 'directory').map((item) => `${item.path.replace(/\/$/, '')}/**`),
      ...(contract.optional ?? []).flatMap((item) => item.type === 'directory'
        ? [item.path, `${item.path.replace(/\/$/, '')}/**`]
        : [item.path]),
    ];
    for (const file of files) {
      if (!allowedPatterns.some((pattern) => matches(file.path, pattern))) {
        issues.push({ code: 'UNDECLARED_PATH', path: file.path, message: `交付件包含规范之外的文件：${file.path}` });
      }
    }
  }

  return {
    valid: issues.length === 0,
    schemaVersion: contract.schemaVersion,
    ...(normalized.rootPrefix ? { rootPrefix: normalized.rootPrefix } : {}),
    fileCount: files.length,
    issues,
  };
}

@Injectable()
export class SubmissionContractService {
  private readonly validators: Record<'1.0' | '1.1', ValidateFunction>;

  constructor(@Inject(ArtifactStore) private readonly artifacts: ArtifactStore) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    this.validators = {
      '1.0': ajv.compile(JSON.parse(readFileSync(join(projectRoot(), 'contracts', 'submission-contract.schema.json'), 'utf8'))),
      '1.1': ajv.compile(JSON.parse(readFileSync(join(projectRoot(), 'contracts', 'submission-contract-v1.1.schema.json'), 'utf8'))),
    };
  }

  assertDefinition(value: unknown): asserts value is SubmissionContractDefinition {
    const version = (value as { schemaVersion?: string } | undefined)?.schemaVersion;
    if (version !== '1.0' && version !== '1.1') {
      throw new BadRequestException({ code: 'SUBMISSION_CONTRACT_VERSION_UNSUPPORTED', message: '交付目录规范版本必须是 1.0 或 1.1' });
    }
    const validator = this.validators[version];
    if (!validator(value)) {
      const errors = (validator.errors ?? []).map((error) => `${error.instancePath || '$'} ${error.message ?? 'invalid'}`);
      throw new BadRequestException({ code: 'SUBMISSION_CONTRACT_INVALID', message: '交付目录规范不完整', errors });
    }
  }

  resolve(version: ChallengeVersion): SubmissionContractDefinition | undefined {
    if (version.submissionContractDefinition) {
      this.assertDefinition(version.submissionContractDefinition);
      return JSON.parse(JSON.stringify(version.submissionContractDefinition)) as SubmissionContractDefinition;
    }
    assertRepositoryPath(version.submissionContract);
    const path = join(projectRoot(), version.submissionContract);
    if (!existsSync(path)) throw new BadRequestException({ code: 'SUBMISSION_CONTRACT_NOT_FOUND', message: `交付目录规范不存在：${version.submissionContract}` });
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch {
      throw new BadRequestException({ code: 'SUBMISSION_CONTRACT_INVALID', message: '交付目录规范不是合法 JSON' });
    }
    // Older catalogue items pointed at the JSON Schema itself. Keep them
    // readable, but only an actual contract definition enables upload checks.
    if (typeof (parsed as { schemaVersion?: unknown })?.schemaVersion !== 'string') return undefined;
    this.assertDefinition(parsed);
    return parsed;
  }

  async validateArtifact(version: ChallengeVersion, artifactUri: string): Promise<SubmissionContractReport | undefined> {
    const contract = this.resolve(version);
    if (!contract) return undefined;
    const report = validateSubmissionEntries(await this.artifacts.inspectArchive(artifactUri), contract);
    if (!report.valid) {
      throw new BadRequestException({ code: 'DELIVERY_STRUCTURE_INVALID', message: '交付目录不符合赛题要求', issues: report.issues });
    }
    return report;
  }

  validateWorkspace(version: ChallengeVersion, workspacePath: string): SubmissionContractReport | undefined {
    const contract = this.resolve(version);
    if (!contract) return undefined;
    const root = realpathSync(resolve(process.env.LOCAL_WORKSPACE_ROOT ?? projectRoot()));
    const target = realpathSync(resolve(root, workspacePath));
    const child = relative(root, target);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new BadRequestException({ code: 'WORKSPACE_PATH_INVALID', message: '本地交付目录必须位于允许的工作区内' });
    }
    const entries: ArtifactEntry[] = [];
    const walk = (directory: string, prefix = ''): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = join(directory, entry.name);
        if (entry.isSymbolicLink() || lstatSync(fullPath).isSymbolicLink()) {
          throw new BadRequestException({ code: 'DELIVERY_SYMLINK_FORBIDDEN', message: `交付目录不允许符号链接：${path}` });
        }
        if (entry.isDirectory()) {
          entries.push({ path, type: 'directory', size: 0 });
          walk(fullPath, path);
        } else if (entry.isFile()) {
          entries.push({ path, type: 'file', size: lstatSync(fullPath).size });
        }
      }
    };
    walk(target);
    const report = validateSubmissionEntries(entries, contract);
    if (!report.valid) throw new BadRequestException({ code: 'DELIVERY_STRUCTURE_INVALID', message: '交付目录不符合赛题要求', issues: report.issues });
    return report;
  }
}
