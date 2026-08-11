import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppUser, AuditRecord, OrgUnit, SsoIdentity } from './domain';
import { hasGlobalAdminAccess } from './access-control';
import {
  AuditAppendInput,
  AuditRepository,
  OrganizationRepository,
  OrgUnitListQuery,
  PageInfo,
  PlatformRepository,
  NormalizedUserListQuery,
  RepositoryTransaction,
  SortOrder,
  UserPage,
  UserPatch,
  UserRepository,
} from './repository';
import { PrismaChallengeRepository, PrismaEventRepository, PrismaSubmissionRepository } from './prisma-domain-repository';
import { SerialExecutionQueue } from './postgres-domain-unit-of-work';

type PrismaExecutor = PrismaClient | Prisma.TransactionClient;
type UserRow = Prisma.AppUserGetPayload<{ include: { roleBindings: true } }>;
const PLATFORM_SNAPSHOT_ID = 'singleton';

async function bumpPlatformRevision(db: PrismaExecutor): Promise<void> {
  await db.platformSnapshot.upsert({
    where: { id: PLATFORM_SNAPSHOT_ID },
    update: { revision: { increment: 1 } },
    create: { id: PLATFORM_SNAPSHOT_ID, schemaVersion: 1, revision: 1, state: {} },
  });
}

function normalizeOrgPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

function orgPathScopeWhere(paths: readonly string[]): Prisma.AppUserWhereInput | undefined {
  const normalized = [...new Set(paths.map(normalizeOrgPath))];
  if (!normalized.length || normalized.includes('/')) return undefined;
  return {
    OR: normalized.map((path) => ({ orgPath: { startsWith: path } })),
  };
}

function jsonStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function mapOrgUnit(row: {
  id: string;
  parentId: string | null;
  path: string;
  level: number;
  label: string;
  name: string;
}): OrgUnit {
  return {
    id: row.id,
    ...(row.parentId ? { parentId: row.parentId } : {}),
    path: row.path,
    level: row.level,
    label: row.label,
    name: row.name,
  };
}

export function mapUser(row: UserRow): AppUser {
  const bindings = row.roleBindings.map((binding) => ({ role: binding.role, scopeOrgPath: binding.scopeOrgPath }));
  const roles = jsonStringArray(row.roles);
  // Older imported rows may have only role bindings. Keep the projection
  // compatible with the file adapter while the data migration is running.
  const mergedRoles = [...new Set([...roles, ...bindings.map((binding) => binding.role)])];
  return {
    id: row.id,
    employeeNo: row.employeeNo,
    name: row.name,
    ...(row.nickname ? { nickname: row.nickname } : {}),
    ...(row.avatarDataUrl ? { avatarDataUrl: row.avatarDataUrl } : {}),
    orgUnitId: row.orgUnitId ?? '',
    orgPath: row.orgPath ?? '',
    ...(row.departmentHint ? { departmentHint: row.departmentHint } : {}),
    ...(row.departmentSource === 'SSO' || row.departmentSource === 'ADMIN' ? { departmentSource: row.departmentSource } : {}),
    roles: mergedRoles,
    ...(bindings.length ? { roleBindings: bindings } : {}),
    status: row.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
  };
}

function pageInfo(page: number, pageSize: number, total: number): PageInfo {
  const totalPages = total ? Math.ceil(total / pageSize) : 0;
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: totalPages > 0 && page < totalPages,
    hasPrevious: totalPages > 0 && page > 1,
  };
}

class PrismaOrganizationRepository implements OrganizationRepository {
  constructor(private readonly db: PrismaExecutor) {}

  async list(query: OrgUnitListQuery = {}): Promise<OrgUnit[]> {
    const rows = await this.db.orgUnit.findMany({
      where: {
        ...(query.parentId !== undefined ? { parentId: query.parentId } : {}),
        ...(query.pathPrefix ? { path: { startsWith: normalizeOrgPath(query.pathPrefix) } } : {}),
      },
      orderBy: [{ path: 'asc' }, { id: 'asc' }],
    });
    return rows.map(mapOrgUnit);
  }

  async getById(id: string): Promise<OrgUnit | undefined> {
    const row = await this.db.orgUnit.findUnique({ where: { id } });
    return row ? mapOrgUnit(row) : undefined;
  }

  async create(input: OrgUnit): Promise<OrgUnit> {
    try {
      const row = await this.db.orgUnit.create({
        data: {
          id: input.id,
          parentId: input.parentId,
          path: input.path,
          level: input.level,
          label: input.label,
          name: input.name,
        },
      });
      return mapOrgUnit(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`org unit already exists or has a duplicate sibling name: ${input.id}`);
      }
      throw error;
    }
  }

  async update(id: string, patch: Pick<OrgUnit, 'label' | 'name'>): Promise<OrgUnit> {
    try {
      const row = await this.db.orgUnit.update({ where: { id }, data: patch });
      return mapOrgUnit(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException(`org unit not found: ${id}`);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('同一上级部门下已存在同名部门');
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const unit = await this.db.orgUnit.findUnique({ where: { id }, select: { id: true, path: true, level: true } });
    if (!unit) throw new NotFoundException(`org unit not found: ${id}`);
    if (await this.db.orgUnit.count({ where: { parentId: id } })) {
      throw new ConflictException('该部门仍有下级部门，请先调整组织结构');
    }
    if (await this.db.appUser.count({ where: { orgUnitId: id } })) {
      throw new ConflictException('该部门仍有员工，请先调整员工所属部门');
    }
    if (await this.db.roleBinding.count({ where: { scopeOrgPath: unit.path } })) {
      throw new ConflictException('该部门仍绑定管理员权限，请先调整权限范围');
    }
    const scopedEvents = await this.db.event.findMany({ select: { accessPolicy: true } });
    if (scopedEvents.some((event) => {
      const policy = event.accessPolicy;
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return false;
      const departmentIds = (policy as Record<string, unknown>).departmentIds;
      return Array.isArray(departmentIds) && departmentIds.includes(id);
    })) {
      throw new ConflictException('该部门仍用于训练面向对象，请先调整训练范围');
    }
    const challenges = await this.db.challenge.findMany({ select: { ownerOrgPath: true, board: true } });
    if (challenges.some((challenge) => {
      if (challenge.ownerOrgPath === unit.path) return true;
      const board = challenge.board;
      return Boolean(board && typeof board === 'object' && !Array.isArray(board) && (board as Record<string, unknown>).orgPath === unit.path);
    })) {
      throw new ConflictException('该部门仍有关联业务数据，暂不能删除');
    }
    if (await this.db.announcement.count({ where: { orgPath: unit.path } })) {
      throw new ConflictException('该部门仍有关联公告，暂不能删除');
    }
    try {
      await this.db.orgUnit.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException(`org unit not found: ${id}`);
      }
      throw error;
    }
  }
}

class PrismaUserRepository implements UserRepository {
  constructor(protected readonly db: PrismaExecutor) {}

  async list(query: NormalizedUserListQuery): Promise<UserPage> {
    const requestedPath = query.orgPath?.trim() ? normalizeOrgPath(query.orgPath) : undefined;
    const roleFilters = [...new Set(query.roles ?? [])].filter(Boolean);
    const scopeWhere = query.scopeOrgPaths ? orgPathScopeWhere(query.scopeOrgPaths) : undefined;
    const and: Prisma.AppUserWhereInput[] = [];
    if (scopeWhere) and.push(scopeWhere);
    if (roleFilters.length) {
      and.push({
        OR: roleFilters.flatMap((role) => [
          { roles: { array_contains: [role] } },
          { roleBindings: { some: { role } } },
        ]),
      });
    }
    const where: Prisma.AppUserWhereInput = {
      ...(requestedPath && requestedPath !== '/'
        ? { orgPath: { startsWith: requestedPath } }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.query?.trim()
        ? {
          OR: [
            { employeeNo: { contains: query.query.trim(), mode: 'insensitive' } },
            { name: { contains: query.query.trim(), mode: 'insensitive' } },
            { nickname: { contains: query.query.trim(), mode: 'insensitive' } },
          ],
        }
        : {}),
      ...(and.length ? { AND: and } : {}),
    };
    const orderByField = query.sortBy;
    const direction: SortOrder = query.sortOrder;
    const orderBy = [
      { [orderByField]: direction },
      // Keep the final tie-breaker ascending, matching the file adapter and
      // preventing a sort direction change from reversing equal-value pages.
      { id: 'asc' },
    ] as Prisma.AppUserOrderByWithRelationInput[];
    const [total, rows] = await Promise.all([
      this.db.appUser.count({ where }),
      this.db.appUser.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { roleBindings: true },
      }),
    ]);
    return { items: rows.map(mapUser), pageInfo: pageInfo(query.page, query.pageSize, total) };
  }

  async getById(id: string): Promise<AppUser | undefined> {
    const row = await this.db.appUser.findUnique({ where: { id }, include: { roleBindings: true } });
    return row ? mapUser(row) : undefined;
  }

  async getByEmployeeNo(employeeNo: string): Promise<AppUser | undefined> {
    const row = await this.db.appUser.findUnique({ where: { employeeNo }, include: { roleBindings: true } });
    return row ? mapUser(row) : undefined;
  }

  async update(id: string, patch: UserPatch): Promise<AppUser> {
    const orgUnit = patch.orgUnitId === undefined
      ? undefined
      : patch.orgUnitId.trim()
        ? await this.db.orgUnit.findUnique({ where: { id: patch.orgUnitId.trim() } })
        : null;
    if (patch.orgUnitId !== undefined && patch.orgUnitId.trim() && !orgUnit) {
      throw new NotFoundException(`org unit not found: ${patch.orgUnitId}`);
    }
    try {
      const row = await this.db.appUser.update({
        where: { id },
        data: {
          ...(patch.orgUnitId !== undefined
            ? {
              orgUnit: orgUnit ? { connect: { id: orgUnit.id } } : { disconnect: true },
              orgPath: orgUnit?.path ?? null,
              departmentSource: orgUnit ? 'ADMIN' : null,
              departmentHint: null,
            }
            : {}),
          ...(patch.roles !== undefined ? { roles: patch.roles as Prisma.InputJsonValue } : {}),
          ...(patch.roleBindings !== undefined
            ? {
              roleBindings: {
                deleteMany: {},
                create: patch.roleBindings.map((binding) => ({
                  role: binding.role,
                  scopeOrgPath: normalizeOrgPath(binding.scopeOrgPath),
                })),
              },
            }
            : {}),
          ...(patch.nickname !== undefined ? { nickname: patch.nickname } : {}),
          ...(patch.avatarDataUrl !== undefined ? { avatarDataUrl: patch.avatarDataUrl } : {}),
        },
        include: { roleBindings: true },
      });
      return mapUser(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException(`user not found: ${id}`);
      }
      throw error;
    }
  }

  async syncSsoIdentity(identity: SsoIdentity): Promise<{ user: AppUser; firstLogin: boolean; departmentMatched: boolean }> {
    const employeeNo = identity.employeeNo?.trim();
    const name = identity.name?.trim();
    const department = identity.department?.trim() || undefined;
    if (!employeeNo) throw new BadRequestException('SSO 工号不能为空');
    if (!name) throw new BadRequestException('SSO 姓名不能为空');
    const configuredBootstrapAdmin = process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO?.trim();
    const bootstrapGlobalAdmin = configuredBootstrapAdmin === employeeNo
      && !(await this.db.appUser.findMany({ include: { roleBindings: true } })).some((row) => hasGlobalAdminAccess(mapUser(row)));
    const matchedUnit = department
      ? await this.db.orgUnit.findFirst({
        where: { level: { gt: 0 }, OR: [{ id: department }, { path: department }, { name: department }] },
      })
      : undefined;
    const existingRow = await this.db.appUser.findUnique({ where: { employeeNo }, include: { roleBindings: true } });
    if (existingRow?.status === 'DISABLED') throw new ForbiddenException('账号已停用');
    if (!existingRow) {
      const row = await this.db.appUser.create({
        data: {
          id: employeeNo,
          employeeNo,
          name,
          orgUnitId: matchedUnit?.id,
          orgPath: matchedUnit?.path,
          departmentHint: matchedUnit ? null : department,
          departmentSource: matchedUnit ? 'SSO' : null,
          roles: bootstrapGlobalAdmin ? ['global_admin'] : ['learner'],
          ...(bootstrapGlobalAdmin
            ? { roleBindings: { create: [{ role: 'global_admin', scopeOrgPath: '/' }] } }
            : {}),
        },
        include: { roleBindings: true },
      });
      return { user: mapUser(row), firstLogin: true, departmentMatched: Boolean(matchedUnit) };
    }
    const data: Prisma.AppUserUpdateInput = {
      name,
      ...(bootstrapGlobalAdmin ? { roles: ['global_admin'] } : {}),
    };
    if (existingRow.departmentSource !== 'ADMIN' && matchedUnit) {
      data.orgUnit = { connect: { id: matchedUnit.id } };
      data.orgPath = matchedUnit.path;
      data.departmentSource = 'SSO';
      data.departmentHint = null;
    } else if (!existingRow.orgUnitId || !existingRow.orgPath) {
      data.orgUnit = matchedUnit ? { connect: { id: matchedUnit.id } } : { disconnect: true };
      data.orgPath = matchedUnit?.path ?? null;
      data.departmentSource = matchedUnit ? 'SSO' : null;
      data.departmentHint = matchedUnit ? null : department;
    } else if (department) {
      data.departmentHint = department;
    }
    if (bootstrapGlobalAdmin) {
      data.roleBindings = {
        connectOrCreate: {
          where: {
            userId_role_scopeOrgPath: {
              userId: existingRow.id,
              role: 'global_admin',
              scopeOrgPath: '/',
            },
          },
          create: { role: 'global_admin', scopeOrgPath: '/' },
        },
      };
    }
    const row = await this.db.appUser.update({ where: { id: existingRow.id }, data, include: { roleBindings: true } });
    return { user: mapUser(row), firstLogin: false, departmentMatched: Boolean(matchedUnit) };
  }
}

class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly db: PrismaExecutor) {}

  private scopedList(query: { target?: string; page: number; pageSize: number; scopeOrgPaths: readonly string[]; viewerId?: string }): Promise<{ items: AuditRecord[]; pageInfo: PageInfo }> {
    const normalized = [...new Set(query.scopeOrgPaths.map(normalizeOrgPath))].filter(Boolean);
    const values = Prisma.join(normalized.map((path) => Prisma.sql`${path}`));
    const scopeArray = Prisma.sql`ARRAY[${values}]::text[]`;
    const pathMatch = (column: Prisma.Sql): Prisma.Sql => Prisma.sql`(
      ${column} IS NOT NULL AND EXISTS (
        SELECT 1 FROM unnest(${scopeArray}) AS scoped(path)
        WHERE scoped.path = '/' OR ${column} = scoped.path OR ${column} LIKE scoped.path || '%'
      )
    )`;
    const eitherPathMatch = (column: Prisma.Sql): Prisma.Sql => Prisma.sql`(
      ${pathMatch(column)} OR EXISTS (
        SELECT 1 FROM unnest(${scopeArray}) AS scoped(path)
        WHERE ${column} IS NOT NULL AND (scoped.path = ${column} OR scoped.path LIKE ${column} || '%')
      )
    )`;
    const viewerFallback = query.viewerId ? Prisma.sql`(
      NOT EXISTS (SELECT 1 FROM "AppUser" unknown_actor WHERE unknown_actor.id = a."actorId")
      AND EXISTS (
        SELECT 1 FROM "AppUser" viewer
        WHERE viewer.id = ${query.viewerId} AND ${pathMatch(Prisma.sql`viewer."orgPath"`)}
      )
    ) OR ` : Prisma.empty;
    const visibility = Prisma.sql`(
      (
        a.target LIKE 'challenge:%' AND EXISTS (
          SELECT 1 FROM "Challenge" c
          WHERE a.target = 'challenge:' || c.id
            AND c."ownerOrgPath" <> '/'
            AND ${pathMatch(Prisma.sql`c."ownerOrgPath"`)}
        )
      )
      OR (
        a.target LIKE 'event:%' AND EXISTS (
          SELECT 1
          FROM "Event" e
          JOIN "ChallengeVersion" cv ON cv.id = e."challengeVersionId"
          JOIN "Challenge" c ON c.id = cv."challengeId"
          WHERE a.target = 'event:' || e.id
            AND (
              (c."ownerOrgPath" <> '/' AND ${pathMatch(Prisma.sql`c."ownerOrgPath"`)})
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(COALESCE(e."accessPolicy", '{}'::jsonb)->'departmentIds') AS department(id)
                JOIN "OrgUnit" ou ON ou.id = department.id
                WHERE ${eitherPathMatch(Prisma.sql`ou.path`)}
              )
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(COALESCE(e."accessPolicy", '{}'::jsonb)->'subjectIds') AS selected(id)
                JOIN "AppUser" selected_user ON selected_user.id = selected.id
                WHERE ${pathMatch(Prisma.sql`selected_user."orgPath"`)}
              )
              OR EXISTS (
                SELECT 1 FROM "Participation" p
                WHERE p."eventId" = e.id AND ${pathMatch(Prisma.sql`p."orgPathSnapshot"`)}
              )
            )
        )
      )
      OR (
        a.target LIKE 'submission:%' AND EXISTS (
          SELECT 1
          FROM "Submission" s
          JOIN "AppUser" submission_user ON submission_user.id = s."subjectId"
          WHERE a.target = 'submission:' || s.id
            AND ${pathMatch(Prisma.sql`submission_user."orgPath"`)}
        )
      )
      OR (
        a.target LIKE 'announcement:%' AND EXISTS (
          SELECT 1 FROM "Announcement" n
          WHERE a.target = 'announcement:' || n.id AND ${pathMatch(Prisma.sql`n."orgPath"`)}
        )
      )
      OR (
        a.target NOT LIKE 'challenge:%'
        AND a.target NOT LIKE 'event:%'
        AND a.target NOT LIKE 'submission:%'
        AND a.target NOT LIKE 'announcement:%'
        AND (
          ${viewerFallback}EXISTS (
            SELECT 1 FROM "AppUser" audit_actor
            WHERE audit_actor.id = a."actorId" AND ${pathMatch(Prisma.sql`audit_actor."orgPath"`)}
          )
        )
      )
    )`;
    const target = query.target ? Prisma.sql`a.target = ${query.target}` : Prisma.sql`TRUE`;
    const offset = (query.page - 1) * query.pageSize;
    return (async () => {
      const countRows = await this.db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*)::bigint AS count FROM "AuditLog" a WHERE ${target} AND ${visibility}`);
      const rows = await this.db.$queryRaw<Array<{ id: string; actorId: string; action: string; target: string; before: unknown; after: unknown; createdAt: Date }>>(Prisma.sql`
        SELECT a.id, a."actorId", a.action, a.target, a.before, a.after, a."createdAt"
        FROM "AuditLog" a
        WHERE ${target} AND ${visibility}
        ORDER BY a."createdAt" DESC, a.id DESC
        LIMIT ${query.pageSize} OFFSET ${offset}
      `);
      const total = Number(countRows[0]?.count ?? 0);
      return {
        items: rows.map((row) => ({
          id: row.id,
          actorId: row.actorId,
          action: row.action,
          target: row.target,
          ...(row.before !== null ? { before: row.before } : {}),
          ...(row.after !== null ? { after: row.after } : {}),
          createdAt: new Date(row.createdAt).toISOString(),
        })),
        pageInfo: pageInfo(query.page, query.pageSize, total),
      };
    })();
  }

  async append(input: AuditAppendInput): Promise<AuditRecord> {
    const row = await this.db.auditLog.create({
      data: {
        id: input.id || randomUUID(),
        actorId: input.actorId,
        action: input.action,
        target: input.target,
        before: input.before as Prisma.InputJsonValue | undefined,
        after: input.after as Prisma.InputJsonValue | undefined,
        createdAt: new Date(input.createdAt),
      },
    });
    return {
      id: row.id,
      actorId: row.actorId,
      action: row.action,
      target: row.target,
      ...(row.before !== null ? { before: row.before } : {}),
      ...(row.after !== null ? { after: row.after } : {}),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(query: { target?: string; page?: number; pageSize?: number; scopeOrgPaths?: readonly string[]; viewerId?: string } = {}): Promise<{ items: AuditRecord[]; pageInfo: PageInfo }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    if (!Number.isSafeInteger(page) || page < 1) throw new BadRequestException('page must be a positive integer');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BadRequestException('pageSize must be between 1 and 100');
    if (query.scopeOrgPaths?.length) return this.scopedList({ ...query, page, pageSize, scopeOrgPaths: query.scopeOrgPaths });
    const where = query.target ? { target: query.target } : undefined;
    const [total, rows] = await Promise.all([
      this.db.auditLog.count({ where }),
      this.db.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        action: row.action,
        target: row.target,
        ...(row.before !== null ? { before: row.before } : {}),
        ...(row.after !== null ? { after: row.after } : {}),
        createdAt: row.createdAt.toISOString(),
      })),
      pageInfo: pageInfo(page, pageSize, total),
    };
  }
}

class AtomicRootUserRepository implements UserRepository {
  constructor(private readonly base: PrismaUserRepository, private readonly owner: PrismaPlatformRepository) {}
  private readonly syncFlights = new Map<string, Promise<{ user: AppUser; firstLogin: boolean; departmentMatched: boolean }>>();
  list(query: NormalizedUserListQuery): Promise<UserPage> { return this.base.list(query); }
  getById(id: string): Promise<AppUser | undefined> { return this.base.getById(id); }
  getByEmployeeNo(employeeNo: string): Promise<AppUser | undefined> { return this.base.getByEmployeeNo(employeeNo); }
  update(id: string, patch: UserPatch): Promise<AppUser> { return this.base.update(id, patch); }
  syncSsoIdentity(identity: SsoIdentity): Promise<{ user: AppUser; firstLogin: boolean; departmentMatched: boolean }> {
    const employeeNo = identity.employeeNo?.trim();
    if (!employeeNo) return this.syncSsoIdentityOnce(identity);
    const pending = this.syncFlights.get(employeeNo);
    if (pending) return pending.then((result) => ({ ...result, firstLogin: false }));
    const operation = this.syncSsoIdentityOnce({ ...identity, employeeNo }).finally(() => {
      if (this.syncFlights.get(employeeNo) === operation) this.syncFlights.delete(employeeNo);
    });
    this.syncFlights.set(employeeNo, operation);
    return operation;
  }

  private syncSsoIdentityOnce(identity: SsoIdentity): Promise<{ user: AppUser; firstLogin: boolean; departmentMatched: boolean }> {
    const run = () => this.owner.transaction(async (transaction) => {
      const result = await transaction.users.syncSsoIdentity(identity);
      await transaction.audits.append({
        id: randomUUID(),
        actorId: result.user.id,
        action: result.firstLogin ? 'sso.user-provision' : 'sso.user-sync',
        target: `user:${result.user.id}`,
        after: result.user,
        createdAt: new Date().toISOString(),
      });
      return result;
    });
    // The in-process single-flight above handles the normal browser burst.
    // Keep database retries as a safety net for another API instance or a
    // worker that provisions the same identity at the same time.
    const retryable = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code);
    const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    return (async () => {
      const maxAttempts = 6;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await run();
        } catch (error) {
          if (!retryable(error) || attempt === maxAttempts) throw error;
          await wait(Math.min(250, 10 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 15));
        }
      }
      throw new Error('unreachable');
    })();
  }
}

export interface PrismaPlatformRepositoryOptions {
  client?: PrismaClient;
}

/** PostgreSQL implementation of the v0.7 repository port. */
export class PrismaPlatformRepository implements PlatformRepository {
  readonly organizations: OrganizationRepository;
  readonly users: UserRepository;
  readonly audits: AuditRepository;
  readonly challenges: PrismaChallengeRepository;
  readonly events: PrismaEventRepository;
  readonly submissions: PrismaSubmissionRepository;
  private readonly client: PrismaClient;
  private readonly ownsClient: boolean;
  private readonly writes = new SerialExecutionQueue();

  constructor(options: PrismaPlatformRepositoryOptions = {}) {
    this.client = options.client ?? new PrismaClient();
    this.ownsClient = !options.client;
    this.organizations = new PrismaOrganizationRepository(this.client);
    this.users = new AtomicRootUserRepository(new PrismaUserRepository(this.client), this);
    this.audits = new PrismaAuditRepository(this.client);
    this.challenges = new PrismaChallengeRepository(this.client);
    this.events = new PrismaEventRepository(this.client);
    this.submissions = new PrismaSubmissionRepository(this.client);
  }

  async transaction<T>(work: (transaction: RepositoryTransaction) => Promise<T>): Promise<T> {
    return this.writes.run(() => this.client.$transaction(async (client) => {
      const result = await work({
        organizations: new PrismaOrganizationRepository(client),
        users: new PrismaUserRepository(client),
        audits: new PrismaAuditRepository(client),
        challenges: new PrismaChallengeRepository(client),
        events: new PrismaEventRepository(client),
        submissions: new PrismaSubmissionRepository(client),
      });
      await bumpPlatformRevision(client);
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
  }

  async close(): Promise<void> {
    await this.writes.drain();
    if (this.ownsClient) await this.client.$disconnect();
  }
}
