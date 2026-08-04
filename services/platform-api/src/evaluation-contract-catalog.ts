import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { EvaluationEngineConfig, EvaluationEngineMode } from './domain';

export type EvaluationContractKind = 'INPUT' | 'OUTPUT';
export type EvaluationContractVisibility = 'PUBLIC' | 'INTERNAL';

export interface EvaluationContractCatalogItem {
  id: string;
  kind: EvaluationContractKind;
  visibility: EvaluationContractVisibility;
  modes: EvaluationEngineMode[];
  schemaVersion: string;
  path: string;
  label: string;
  description: string;
  examplePath: string;
  guidePath: string;
}

export interface EvaluationContractDetail extends EvaluationContractCatalogItem {
  /** The Git-pinned JSON Schema used to validate this constraint. */
  schema: unknown;
  /** A checked-in example that conforms to `schema`. */
  example: unknown;
  /** Authoring guidance that can be shown to administrators and copied to AI. */
  guide: string;
}

interface EvaluationContractCatalogFile {
  schemaVersion: '1.0';
  contracts: EvaluationContractCatalogItem[];
}

function projectRoot(): string {
  const cwd = process.cwd();
  return resolve(process.env.PROJECT_ROOT ?? (existsSync(join(cwd, 'grader', 'run_grader.py')) ? cwd : join(cwd, '..', '..')));
}

function repositoryFile(root: string, repositoryPath: string, label: string): string {
  const target = resolve(root, repositoryPath);
  const child = relative(root, target);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${label} must stay inside the project root: ${repositoryPath}`);
  }
  if (!existsSync(target)) throw new Error(`${label} does not exist: ${repositoryPath}`);
  return target;
}

/**
 * Git is the source of truth for platform-owned evaluation contracts. This
 * service validates the catalog and every referenced example at API startup,
 * then exposes only public choices to the administrator UI.
 */
@Injectable()
export class EvaluationContractCatalogService {
  private readonly root = projectRoot();
  private readonly contracts: EvaluationContractCatalogItem[];
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly details = new Map<string, EvaluationContractDetail>();

  constructor() {
    const catalogPath = repositoryFile(this.root, 'contracts/evaluation-contract-catalog.json', 'evaluation contract catalog');
    const catalogSchemaPath = repositoryFile(this.root, 'contracts/evaluation-contract-catalog.schema.json', 'evaluation contract catalog schema');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as EvaluationContractCatalogFile;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validateCatalog = ajv.compile(JSON.parse(readFileSync(catalogSchemaPath, 'utf8')));
    if (!validateCatalog(catalog)) {
      const errors = (validateCatalog.errors ?? []).map((error) => `${error.instancePath || '$'} ${error.message ?? 'invalid'}`).join('; ');
      throw new Error(`evaluation contract catalog is invalid: ${errors}`);
    }

    const ids = new Set<string>();
    const selections = new Set<string>();
    const schemaValidators = new Map<string, ValidateFunction>();
    for (const item of catalog.contracts) {
      if (ids.has(item.id)) throw new Error(`evaluation contract id is duplicated: ${item.id}`);
      ids.add(item.id);
      const selectionKey = `${item.kind}:${item.path}:${item.schemaVersion}:${item.modes.slice().sort().join(',')}`;
      if (selections.has(selectionKey)) throw new Error(`evaluation contract selection is duplicated: ${selectionKey}`);
      selections.add(selectionKey);
      const schemaPath = repositoryFile(this.root, item.path, `evaluation contract schema ${item.id}`);
      const examplePath = repositoryFile(this.root, item.examplePath, `evaluation contract example ${item.id}`);
      const guidePath = repositoryFile(this.root, item.guidePath, `evaluation contract guide ${item.id}`);
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as unknown;
      const validateExample = schemaValidators.get(item.path) ?? ajv.compile(schema as Record<string, unknown>);
      schemaValidators.set(item.path, validateExample);
      const example = JSON.parse(readFileSync(examplePath, 'utf8')) as unknown;
      if (!validateExample(example)) {
        const errors = (validateExample.errors ?? []).map((error) => `${error.instancePath || '$'} ${error.message ?? 'invalid'}`).join('; ');
        throw new Error(`evaluation contract example is invalid for ${item.id}: ${errors}`);
      }
      this.validators.set(item.id, validateExample);
      this.details.set(item.id, {
        ...item,
        modes: [...item.modes],
        schema,
        example,
        guide: readFileSync(guidePath, 'utf8'),
      });
    }
    this.contracts = catalog.contracts.map((item) => ({ ...item, modes: [...item.modes] }));
  }

  list(): EvaluationContractCatalogItem[] {
    return this.contracts
      .filter((item) => item.visibility === 'PUBLIC')
      .map((item) => ({ ...item, modes: [...item.modes] }));
  }

  listForMode(mode: EvaluationEngineMode): EvaluationContractCatalogItem[] {
    return this.list().filter((item) => item.modes.includes(mode));
  }

  /** Return the complete public detail for the administrator's detail view. */
  get(id: string): EvaluationContractDetail {
    const detail = this.details.get(id.trim());
    if (!detail || detail.visibility !== 'PUBLIC') {
      throw new NotFoundException({ code: 'EVALUATION_CONTRACT_NOT_FOUND', message: `评测约束不存在: ${id}` });
    }
    return {
      ...detail,
      modes: [...detail.modes],
    };
  }

  /** Validate challenge configuration against the immutable Git catalog. */
  assertSelection(engine?: EvaluationEngineConfig): void {
    if (!engine) return;
    const selections: Array<[EvaluationContractKind, EvaluationEngineConfig['input'] | EvaluationEngineConfig['output']]> = [
      ['INPUT', engine.input],
      ['OUTPUT', engine.output],
    ];
    for (const [kind, contract] of selections) {
      const match = this.contracts.find((item) => item.kind === kind
        && item.modes.includes(engine.mode)
        && item.schemaVersion === contract?.schemaVersion
        && item.path === contract?.contractPath);
      if (!match) {
        throw new BadRequestException({
          code: 'EVALUATION_CONTRACT_NOT_ALLOWED',
          message: `${kind === 'INPUT' ? '输入' : '输出'}契约不在当前评测方式的 Git 契约目录中`,
          details: { mode: engine.mode, schemaVersion: contract?.schemaVersion, contractPath: contract?.contractPath },
        });
      }
    }
  }

  /** Used by tests and diagnostics to verify a catalog item has a live schema. */
  validateExample(id: string, value: unknown): boolean {
    const validator = this.validators.get(id);
    if (!validator) throw new BadRequestException({ code: 'EVALUATION_CONTRACT_NOT_FOUND', message: `评测约束不存在: ${id}` });
    return Boolean(validator(value));
  }
}
