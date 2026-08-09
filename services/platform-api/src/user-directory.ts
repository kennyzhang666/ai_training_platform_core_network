import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AppUser, AuditRecord, OrgUnit, AdminAccess } from './domain';
import { hasGlobalAdminAccess, normalizeOrgPath, orgPathIncludes, resolveAdminAccess, assertAdminOrgScope } from './access-control';
import { AuditAppendInput, NormalizedUserListQuery, PageInfo, UserListQuery, UserPage, UserPatch } from './repository';
import { PlatformStore } from './store';
import { PrismaPlatformRepository } from './prisma-platform-repository';
import { randomUUID } from 'node:crypto';
import { isSingleNodeProduction } from './deployment-profile';

export const USER_DIRECTORY_REPOSITORY = Symbol('USER_DIRECTORY_REPOSITORY');

export interface UserDirectoryRepository {
  getById(id: string): Promise<AppUser | undefined>;
  getOrgUnit(id: string): Promise<OrgUnit | undefined>;
  listOrgUnits(parentId?: string): Promise<OrgUnit[]>;
  createOrgUnit(input: OrgUnit, actorId: string): Promise<OrgUnit>;
  updateOrgUnit(id: string, patch: Partial<Pick<OrgUnit, 'label' | 'name'>>, actorId: string): Promise<OrgUnit>;
  deleteOrgUnit(id: string, actorId: string): Promise<void>;
  list(query: NormalizedUserListQuery): Promise<UserPage>;
  updateWithAudit(id: string, patch: UserPatch, audit: AuditAppendInput): Promise<AppUser>;
  syncSsoIdentity(identity: import('./domain').SsoIdentity): Promise<{ user: AppUser; firstLogin: boolean; departmentMatched: boolean }>;
  close?(): Promise<void>;
}

function pageInfo(page: number, pageSize: number, total: number): PageInfo {
  const totalPages = total ? Math.ceil(total / pageSize) : 0;
  return { page, pageSize, total, totalPages, hasNext: totalPages > 0 && page < totalPages, hasPrevious: totalPages > 0 && page > 1 };
}

function filePage(users: AppUser[], query: NormalizedUserListQuery): UserPage {
  const requestedPath = query.orgPath?.trim() ? normalizeOrgPath(query.orgPath) : undefined;
  const scopePaths = query.scopeOrgPaths?.map(normalizeOrgPath);
  const normalizedQuery = query.query?.trim().toLocaleLowerCase('zh-CN') ?? '';
  const roles = new Set((query.roles ?? []).map((role) => role.trim()).filter(Boolean));
  const compare = (left: string, right: string) => left.localeCompare(right, 'zh-CN', { sensitivity: 'base', numeric: true });
  const filtered = users.filter((user) => {
    if (scopePaths?.length && !scopePaths.includes('/') && !scopePaths.some((scope) => orgPathIncludes(scope, user.orgPath))) return false;
    if (requestedPath && !orgPathIncludes(requestedPath, user.orgPath)) return false;
    if (normalizedQuery && ![user.employeeNo, user.name, user.nickname ?? ''].some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedQuery))) return false;
    if (roles.size && ![...roles].some((role) => user.roles.includes(role))) return false;
    if (query.status && user.status !== query.status) return false;
    return true;
  }).sort((left, right) => {
    const primary = compare(String(left[query.sortBy]), String(right[query.sortBy])) * (query.sortOrder === 'desc' ? -1 : 1);
    return primary || compare(left.id, right.id);
  });
  return {
    items: filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
    pageInfo: pageInfo(query.page, query.pageSize, filtered.length),
  };
}

/** Local adapter for the user-directory port while the rest of PlatformStore is being migrated. */
export class FileUserDirectoryRepository implements UserDirectoryRepository {
  constructor(private readonly store: PlatformStore) {}

  async getById(id: string): Promise<AppUser | undefined> {
    try { return this.store.getUser(id); } catch { return undefined; }
  }

  async getOrgUnit(id: string): Promise<OrgUnit | undefined> {
    try { return this.store.getOrgUnit(id); } catch { return undefined; }
  }

  async listOrgUnits(parentId?: string): Promise<OrgUnit[]> {
    // Authorization is applied by UserDirectoryService using the real actor.
    // Read the file snapshot directly so an empty production store does not
    // depend on a seeded development administrator.
    return this.store.exportState().orgUnits.filter((unit) => unit.parentId === parentId);
  }

  async createOrgUnit(input: OrgUnit, actorId: string): Promise<OrgUnit> {
    return this.store.createOrgUnit(input, actorId);
  }

  async updateOrgUnit(id: string, patch: Partial<Pick<OrgUnit, 'label' | 'name'>>, actorId: string): Promise<OrgUnit> {
    return this.store.updateOrgUnit(id, patch, actorId);
  }

  async deleteOrgUnit(id: string, actorId: string): Promise<void> {
    this.store.deleteOrgUnit(id, actorId);
  }

  async list(query: NormalizedUserListQuery): Promise<UserPage> {
    return filePage(this.store.exportState().users, query);
  }

  async updateWithAudit(id: string, patch: UserPatch, audit: AuditAppendInput): Promise<AppUser> {
    // PlatformStore keeps the established file-adapter validation and audit
    // behavior. The application service has already performed the same
    // authorization checks before reaching this adapter.
    if (patch.nickname !== undefined || patch.avatarDataUrl !== undefined) {
      return this.store.updateUserProfile(id, {
        ...(patch.nickname !== undefined ? { nickname: patch.nickname } : {}),
        ...(patch.avatarDataUrl !== undefined ? { avatarDataUrl: patch.avatarDataUrl } : {}),
      }, audit.actorId);
    }
    return this.store.updateUser(id, {
      ...(patch.orgUnitId !== undefined ? { orgUnitId: patch.orgUnitId } : {}),
      ...(patch.roles !== undefined ? { roles: [...patch.roles] } : {}),
      ...(patch.roleBindings !== undefined ? { roleBindings: patch.roleBindings.map((binding) => ({ ...binding })) } : {}),
    }, audit.actorId);
  }

  async syncSsoIdentity(identity: import('./domain').SsoIdentity): Promise<{ user: AppUser; firstLogin: boolean; departmentMatched: boolean }> {
    return this.store.syncSsoIdentity(identity);
  }
}

export class PrismaUserDirectoryRepository implements UserDirectoryRepository {
  constructor(private readonly repository: PrismaPlatformRepository, private readonly store: PlatformStore) {}
  getById(id: string): Promise<AppUser | undefined> { return this.repository.users.getById(id); }
  getOrgUnit(id: string): Promise<OrgUnit | undefined> { return this.repository.organizations.getById(id); }
  listOrgUnits(parentId?: string): Promise<OrgUnit[]> { return this.repository.organizations.list(parentId === undefined ? {} : { parentId }); }
  createOrgUnit(input: OrgUnit, actorId: string): Promise<OrgUnit> {
    return this.repository.transaction(async (transaction) => {
      const created = await transaction.organizations.create(input);
      await transaction.audits.append({ id: randomUUID(), actorId, action: 'org-unit.create', target: `org-unit:${created.id}`, after: created, createdAt: new Date().toISOString() });
      return created;
    }).then((created) => { this.store.noteExternalCommit(); return created; });
  }
  updateOrgUnit(id: string, patch: Partial<Pick<OrgUnit, 'label' | 'name'>>, actorId: string): Promise<OrgUnit> {
    return this.repository.transaction(async (transaction) => {
      const before = await transaction.organizations.getById(id);
      if (!before) throw new NotFoundException(`org unit not found: ${id}`);
      const updated = await transaction.organizations.update(id, { name: patch.name ?? before.name, label: patch.label ?? before.label });
      await transaction.audits.append({ id: randomUUID(), actorId, action: 'org-unit.update', target: `org-unit:${id}`, before, after: updated, createdAt: new Date().toISOString() });
      return updated;
    }).then((updated) => { this.store.noteExternalCommit(); return updated; });
  }
  deleteOrgUnit(id: string, actorId: string): Promise<void> {
    return this.repository.transaction(async (transaction) => {
      const before = await transaction.organizations.getById(id);
      if (!before) throw new NotFoundException(`org unit not found: ${id}`);
      await transaction.organizations.delete(id);
      await transaction.audits.append({ id: randomUUID(), actorId, action: 'org-unit.delete', target: `org-unit:${id}`, before, createdAt: new Date().toISOString() });
    }).then(() => { this.store.noteExternalCommit(); });
  }
  list(query: NormalizedUserListQuery): Promise<UserPage> { return this.repository.users.list(query); }
  async syncSsoIdentity(identity: import('./domain').SsoIdentity): Promise<{ user: AppUser; firstLogin: boolean; departmentMatched: boolean }> {
    const result = await this.repository.users.syncSsoIdentity(identity);
    this.store.noteExternalCommit();
    return result;
  }
  close(): Promise<void> { return this.repository.close(); }
  async updateWithAudit(id: string, patch: UserPatch, audit: AuditAppendInput): Promise<AppUser> {
    const updated = await this.repository.transaction(async (transaction) => {
      const updated = await transaction.users.update(id, patch);
      await transaction.audits.append({ ...audit, after: audit.after ?? updated });
      return updated;
    });
    this.store.noteExternalCommit();
    return updated;
  }
}

export function createUserDirectoryRepository(store: PlatformStore): UserDirectoryRepository {
  const mode = (process.env.PLATFORM_REPOSITORY ?? 'file').trim().toLowerCase();
  if (mode === 'postgres') {
    if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required when PLATFORM_REPOSITORY=postgres');
    return new PrismaUserDirectoryRepository(new PrismaPlatformRepository(), store);
  }
  if (mode !== 'file') throw new Error(`unsupported PLATFORM_REPOSITORY: ${mode}`);
  if (process.env.NODE_ENV === 'production') {
    if (isSingleNodeProduction()) throw new Error('single-node production requires PLATFORM_REPOSITORY=postgres');
    throw new Error('file repository is not allowed in production');
  }
  return new FileUserDirectoryRepository(store);
}

@Injectable()
export class UserDirectoryService {
  constructor(@Inject(USER_DIRECTORY_REPOSITORY) private readonly repository: UserDirectoryRepository, @Inject(PlatformStore) private readonly store: PlatformStore) {}

  async list(query: UserListQuery, actorId: string): Promise<UserPage> {
    const actor = await this.repository.getById(actorId);
    if (!actor) throw new ForbiddenException('authenticated user was not found');
    const access = resolveAdminAccess(actor);
    const requestedPath = query.orgPath?.trim() ? normalizeOrgPath(query.orgPath) : undefined;
    if (requestedPath && access.level !== 'GLOBAL') assertAdminOrgScope(access, requestedPath);
    const normalized: NormalizedUserListQuery = {
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
      ...(query.orgPath?.trim() ? { orgPath: query.orgPath.trim() } : {}),
      ...(query.query?.trim() ? { query: query.query.trim() } : {}),
      ...(query.roles?.length ? { roles: [...query.roles] } : {}),
      ...(query.status ? { status: query.status } : {}),
      sortBy: query.sortBy ?? 'employeeNo',
      sortOrder: query.sortOrder ?? 'asc',
      scopeOrgPaths: access.level === 'GLOBAL' ? ['/'] : access.scopeOrgPaths,
    };
    return this.repository.list(normalized);
  }

  async listOrgUnits(parentId: string | undefined, actorId: string): Promise<OrgUnit[]> {
    const actor = await this.repository.getById(actorId);
    if (!actor) throw new ForbiddenException('authenticated user was not found');
    let scopes: string[] | undefined;
    try {
      const access = resolveAdminAccess(actor);
      scopes = access.level === 'GLOBAL' ? undefined : access.scopeOrgPaths;
    } catch {
      scopes = actor.orgPath ? [normalizeOrgPath(actor.orgPath)] : [];
    }
    return (await this.repository.listOrgUnits(parentId)).filter((unit) => !scopes || scopes.some((scope) => orgPathIncludes(scope, unit.path) || orgPathIncludes(unit.path, scope)));
  }

  async getOrgUnit(id: string): Promise<OrgUnit> {
    const unit = await this.repository.getOrgUnit(id);
    if (!unit) throw new NotFoundException(`org unit not found: ${id}`);
    return unit;
  }

  private async adminAccess(actorId: string): Promise<{ actor: AppUser; access: AdminAccess }> {
    const actor = await this.repository.getById(actorId);
    if (!actor) throw new ForbiddenException('authenticated user was not found');
    return { actor, access: resolveAdminAccess(actor) };
  }

  async createOrgUnit(input: { id: string; parentId?: string; label?: string; name: string }, actorId: string): Promise<OrgUnit> {
    const { access } = await this.adminAccess(actorId);
    const id = input.id.trim();
    const name = input.name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(id)) throw new BadRequestException('org unit id is invalid');
    if (!name) throw new BadRequestException('org unit name is required');
    const existing = await this.repository.getOrgUnit(id);
    if (existing) throw new ConflictException(`org unit already exists: ${id}`);
    const parent = input.parentId ? await this.repository.getOrgUnit(input.parentId) : undefined;
    if (input.parentId && !parent) throw new NotFoundException(`org unit not found: ${input.parentId}`);
    if (parent && access.level !== 'GLOBAL') assertAdminOrgScope(access, parent.path);
    if (!parent && access.level !== 'GLOBAL') throw new ForbiddenException('department administrators must create units below their organization scope');
    const path = parent ? `${parent.path === '/' ? '/' : parent.path}${id}/`.replace('//', '/') : `/${id}/`;
    if (access.level !== 'GLOBAL' && !access.scopeOrgPaths.some((scope) => orgPathIncludes(scope, path))) throw new ForbiddenException('organization scope does not allow this operation');
    const siblings = await this.repository.listOrgUnits(parent?.id);
    if (siblings.some((unit) => unit.name === name)) throw new ConflictException('同一上级部门下已存在同名部门');
    return this.repository.createOrgUnit({ id, ...(parent ? { parentId: parent.id } : {}), path, level: parent ? parent.level + 1 : 0, label: input.label?.trim() || '组织', name }, actorId);
  }

  async updateOrgUnit(id: string, patch: { label?: string; name?: string }, actorId: string): Promise<OrgUnit> {
    const { access } = await this.adminAccess(actorId);
    const unit = await this.repository.getOrgUnit(id);
    if (!unit) throw new NotFoundException(`org unit not found: ${id}`);
    assertAdminOrgScope(access, unit.path);
    if (patch.name !== undefined && !patch.name.trim()) throw new BadRequestException('org unit name is required');
    if (patch.label !== undefined && !patch.label.trim()) throw new BadRequestException('org unit label is required');
    if (patch.name !== undefined) {
      const siblings = await this.repository.listOrgUnits(unit.parentId);
      if (siblings.some((candidate) => candidate.id !== unit.id && candidate.name === patch.name!.trim())) throw new ConflictException('同一上级部门下已存在同名部门');
    }
    return this.repository.updateOrgUnit(id, { ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.label !== undefined ? { label: patch.label.trim() } : {}) }, actorId);
  }

  async deleteOrgUnit(id: string, actorId: string): Promise<void> {
    const { access } = await this.adminAccess(actorId);
    const unit = await this.repository.getOrgUnit(id);
    if (!unit) throw new NotFoundException(`org unit not found: ${id}`);
    assertAdminOrgScope(access, unit.path);
    if (unit.level === 0 || unit.path === '/') throw new BadRequestException('根组织不可删除');
    if (access.level === 'DEPARTMENT' && access.scopeOrgPaths.some((scope) => normalizeOrgPath(scope) === unit.path)) throw new ForbiddenException('部门管理员不能删除其管理范围的根部门');
    await this.repository.deleteOrgUnit(id, actorId);
  }

  async get(userId: string, actorId: string): Promise<AppUser> {
    const actor = await this.repository.getById(actorId);
    const target = await this.repository.getById(userId);
    if (!actor || !target) throw new ForbiddenException('authenticated user or target user was not found');
    if (actor.id !== target.id) {
      let access: AdminAccess;
      try { access = resolveAdminAccess(actor); } catch { throw new ForbiddenException('administrator role is required'); }
      if (access.level !== 'GLOBAL') {
        if (!access.scopeOrgPaths.some((scope) => orgPathIncludes(scope, target.orgPath))) throw new ForbiddenException('target user is outside the administrator organization scope');
      }
    }
    return target;
  }

  async update(userId: string, patch: UserPatch, actorId: string): Promise<AppUser> {
    const actor = await this.repository.getById(actorId);
    const target = await this.repository.getById(userId);
    if (!actor || !target) throw new ForbiddenException('authenticated user or target user was not found');
    const access = resolveAdminAccess(actor);
    const administratorRoles = new Set(['admin', 'global_admin', 'department_admin']);
    const targetIsAdministrator = target.roles.some((role) => administratorRoles.has(role))
      || Boolean(target.roleBindings?.some((binding) => administratorRoles.has(binding.role)));
    if (access.level !== 'GLOBAL' && targetIsAdministrator) throw new ForbiddenException('管理员账号需由全局管理员配置');
    if (!target.orgPath && access.level !== 'GLOBAL') throw new ForbiddenException('未归属部门的员工需由全局管理员配置部门');
    if (target.orgPath) assertAdminOrgScope(access, target.orgPath);

    const departmentPatchProvided = patch.orgUnitId !== undefined;
    const targetUnit = departmentPatchProvided
      ? (patch.orgUnitId?.trim() ? await this.repository.getOrgUnit(patch.orgUnitId.trim()) : undefined)
      : (target.orgUnitId ? await this.repository.getOrgUnit(target.orgUnitId) : undefined);
    if (departmentPatchProvided && patch.orgUnitId?.trim() && !targetUnit) throw new ForbiddenException('目标部门不存在');
    if (departmentPatchProvided && !targetUnit && access.level !== 'GLOBAL') throw new ForbiddenException('部门管理员只能将员工调整到其管理范围内的部门');
    if (targetUnit?.id === 'org-root') throw new ForbiddenException('员工必须归属具体部门');
    if (targetUnit) assertAdminOrgScope(access, targetUnit.path);

    const nextRoles = patch.roles === undefined ? [...target.roles] : [...new Set(patch.roles.map((role) => role.trim()).filter(Boolean))];
    if (!nextRoles.length) throw new ForbiddenException('至少需要保留一个角色');
    const validRoles = new Set(['learner', 'mentor', 'admin', 'global_admin', 'department_admin']);
    if (nextRoles.some((role) => !validRoles.has(role))) throw new ForbiddenException('角色配置不受支持');
    const nextBindings = patch.roleBindings === undefined
      ? (target.roleBindings ?? []).filter((binding) => nextRoles.includes(binding.role) || (binding.role === 'admin' && nextRoles.includes('admin')))
      : patch.roleBindings.map((binding) => ({ role: binding.role.trim(), scopeOrgPath: normalizeOrgPath(binding.scopeOrgPath) }));
    if (nextBindings.some((binding) => !validRoles.has(binding.role))) throw new ForbiddenException('角色范围配置不受支持');
    if (access.level !== 'GLOBAL' && (nextRoles.some((role) => administratorRoles.has(role)) || nextBindings.some((binding) => administratorRoles.has(binding.role)))) {
      throw new ForbiddenException('只有全局管理员可以分配管理员权限');
    }
    for (const binding of nextBindings) assertAdminOrgScope(access, binding.scopeOrgPath);
    if (nextRoles.includes('department_admin') && !targetUnit?.path) throw new ForbiddenException('部门管理员必须先配置所属部门');
    const bindings = nextBindings.filter((binding) => binding.role !== 'department_admin');
    if (nextRoles.includes('global_admin') && !bindings.some((binding) => binding.role === 'global_admin' && binding.scopeOrgPath === '/')) {
      bindings.push({ role: 'global_admin', scopeOrgPath: '/' });
    }
    if (nextRoles.includes('department_admin') && targetUnit && !bindings.some((binding) => binding.role === 'department_admin' && binding.scopeOrgPath === targetUnit.path)) {
      bindings.push({ role: 'department_admin', scopeOrgPath: targetUnit.path });
    }
    const nextUser: AppUser = {
      ...target,
      ...(departmentPatchProvided ? { orgUnitId: targetUnit?.id ?? '', orgPath: targetUnit?.path ?? '' } : {}),
      roles: nextRoles,
      roleBindings: bindings,
    };
    if (target.id === actorId && access.level === 'GLOBAL' && !hasGlobalAdminAccess(nextUser)) {
      throw new ForbiddenException('全局管理员不能移除自己的全局管理员权限');
    }
    const nextPatch: UserPatch = {
      ...(departmentPatchProvided ? { orgUnitId: targetUnit?.id ?? '' } : {}),
      roles: nextRoles,
      roleBindings: bindings,
    };
    const audit: AuditAppendInput = {
      id: `audit-${randomUUID()}`,
      actorId,
      action: 'user.roles.update',
      target: `user:${userId}`,
      before: target,
      createdAt: new Date().toISOString(),
    };
    const updated = await this.repository.updateWithAudit(userId, nextPatch, audit);
    this.store.cacheUserSnapshot(updated);
    return updated;
  }

  /** Move several employees to one department after validating the complete
   * selection first. The individual update path remains the source of truth
   * for role bindings, audit records and self-admin protection. */
  async updateDepartmentBatch(userIds: readonly string[], orgUnitId: string, actorId: string): Promise<{ requested: number; updated: AppUser[] }> {
    if (!Array.isArray(userIds)) throw new BadRequestException('员工列表格式不正确');
    const ids = [...new Set(userIds.map((id) => typeof id === 'string' ? id.trim() : '').filter(Boolean))];
    if (!ids.length) throw new BadRequestException('至少选择一名员工');
    if (ids.length > 100) throw new BadRequestException('单次最多调整 100 名员工');

    const targetId = typeof orgUnitId === 'string' ? orgUnitId.trim() : '';
    const { access } = await this.adminAccess(actorId);
    const targetUnit = targetId ? await this.repository.getOrgUnit(targetId) : undefined;
    if (targetId && !targetUnit) throw new NotFoundException('目标部门不存在');
    if (targetUnit?.level === 0 || targetUnit?.path === '/') throw new BadRequestException('员工必须归属具体部门');
    if (targetUnit) assertAdminOrgScope(access, targetUnit.path);
    if (!targetId && access.level !== 'GLOBAL') throw new ForbiddenException('部门管理员只能调整到其管理范围内的部门');

    const targets: AppUser[] = [];
    for (const id of ids) {
      const target = await this.repository.getById(id);
      if (!target) throw new NotFoundException(`员工不存在: ${id}`);
      const targetIsAdministrator = target.roles.some((role) => ['admin', 'global_admin', 'department_admin'].includes(role))
        || Boolean(target.roleBindings?.some((binding) => ['admin', 'global_admin', 'department_admin'].includes(binding.role)));
      if (access.level !== 'GLOBAL' && targetIsAdministrator) throw new ForbiddenException('管理员账号需由全局管理员配置');
      if (!target.orgPath && access.level !== 'GLOBAL') throw new ForbiddenException('未归属部门的员工需由全局管理员配置部门');
      if (target.orgPath) assertAdminOrgScope(access, target.orgPath);
      targets.push(target);
    }

    const updated: AppUser[] = [];
    for (const target of targets) {
      updated.push(await this.update(target.id, { orgUnitId: targetId }, actorId));
    }
    return { requested: ids.length, updated };
  }

  async updateProfile(userId: string, patch: Pick<UserPatch, 'nickname' | 'avatarDataUrl'>, actorId: string): Promise<AppUser> {
    const actor = await this.repository.getById(actorId);
    const target = await this.repository.getById(userId);
    if (!actor || !target) throw new ForbiddenException('authenticated user or target user was not found');
    if (actor.status !== 'ACTIVE') throw new ForbiddenException('account is disabled');
    if (actor.id !== target.id) throw new ForbiddenException('只能修改自己的个人资料');
    const redact = (user: AppUser): AppUser => ({
      ...user,
      ...(user.avatarDataUrl ? { avatarDataUrl: `[头像 ${user.avatarDataUrl.length} 字符]` } : {}),
    });
    const audit: AuditAppendInput = {
      id: `audit-${randomUUID()}`,
      actorId,
      action: 'user.profile.update',
      target: `user:${userId}`,
      before: redact(target),
      createdAt: new Date().toISOString(),
    };
    const auditAfter: AppUser = { ...target };
    if (patch.nickname !== undefined) auditAfter.nickname = patch.nickname ?? undefined;
    if (patch.avatarDataUrl !== undefined) auditAfter.avatarDataUrl = patch.avatarDataUrl ?? undefined;
    const updated = await this.repository.updateWithAudit(userId, patch, { ...audit, after: redact(auditAfter) });
    this.store.cacheUserSnapshot(updated);
    return updated;
  }

  async getAdminAccess(actorId: string): Promise<AdminAccess> {
    const actor = await this.repository.getById(actorId);
    if (!actor) throw new ForbiddenException('authenticated user was not found');
    return resolveAdminAccess(actor);
  }

  async syncSsoIdentity(identity: import('./domain').SsoIdentity): Promise<{ user: AppUser; firstLogin: boolean; departmentMatched: boolean }> {
    const result = await this.repository.syncSsoIdentity(identity);
    this.store.cacheUserSnapshot(result.user);
    return result;
  }

  async onModuleDestroy(): Promise<void> {
    await this.repository.close?.();
  }
}
