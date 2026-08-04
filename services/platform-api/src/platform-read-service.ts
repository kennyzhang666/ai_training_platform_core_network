import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { AdminAccess, AppUser } from './domain';
import { orgPathIncludes, resolveAdminAccess } from './access-control';
import { AuditListQuery, AuditPage, SubmissionListQuery, SubmissionPage } from './repository';
import { PlatformStore } from './store';
import { PrismaPlatformRepository } from './prisma-platform-repository';

/**
 * Read-side boundary for the high-cardinality administration lists.
 *
 * The transitional PlatformStore remains the file adapter and the source for
 * the other legacy projections. PostgreSQL requests use normalized repository
 * queries with LIMIT/OFFSET so a large submissions list never requires loading
 * the complete in-process snapshot just to return one page.
 */
@Injectable()
export class PlatformReadService {
  private readonly repository?: PrismaPlatformRepository;

  constructor(@Inject(PlatformStore) private readonly store: PlatformStore) {
    const mode = (process.env.PLATFORM_REPOSITORY ?? 'file').trim().toLowerCase();
    if (mode === 'postgres') this.repository = new PrismaPlatformRepository();
  }

  private async actor(actorId: string): Promise<AppUser> {
    const actor = this.repository ? await this.repository.users.getById(actorId) : (() => {
      try { return this.store.getUser(actorId); } catch { return undefined; }
    })();
    if (!actor) throw new ForbiddenException('authenticated user was not found');
    return actor;
  }

  private async adminAccess(actor: AppUser): Promise<AdminAccess | undefined> {
    try { return resolveAdminAccess(actor); } catch { return undefined; }
  }

  private async accessibleEventIds(access: AdminAccess): Promise<string[] | undefined> {
    if (!this.repository || access.level === 'GLOBAL') return undefined;
    const [events, challenges, units] = await Promise.all([
      this.repository.events.list(),
      this.repository.challenges.list(),
      this.repository.organizations.list(),
    ]);
    const challengeByVersion = new Map(challenges.flatMap((challenge) => challenge.versions.map((version) => [version.id, challenge] as const)));
    const unitById = new Map(units.map((unit) => [unit.id, unit]));
    const subjectCache = new Map<string, AppUser | undefined>();
    const subject = async (id: string): Promise<AppUser | undefined> => {
      if (!subjectCache.has(id)) subjectCache.set(id, await this.repository!.users.getById(id));
      return subjectCache.get(id);
    };
    const inScope = (path: string | undefined): boolean => Boolean(path && access.scopeOrgPaths.some((scope) => orgPathIncludes(scope, path)));
    const allowed: string[] = [];
    for (const event of events) {
      const challenge = challengeByVersion.get(event.challengeVersion);
      if (challenge && challenge.ownerOrgPath !== '/' && inScope(challenge.ownerOrgPath)) {
        allowed.push(event.id);
        continue;
      }
      const policy = event.accessPolicy;
      if (policy?.departmentIds?.some((id) => {
        const unit = unitById.get(id);
        return Boolean(unit && (inScope(unit.path) || access.scopeOrgPaths.some((scope) => orgPathIncludes(unit.path, scope))));
      })) {
        allowed.push(event.id);
        continue;
      }
      if (policy?.subjectIds?.length) {
        let matched = false;
        for (const id of policy.subjectIds) {
          if (inScope((await subject(id))?.orgPath)) { matched = true; break; }
        }
        if (matched) {
          allowed.push(event.id);
          continue;
        }
      }
      const participants = await this.repository.events.listParticipants(event.id);
      if (participants.some((participant) => inScope(participant.orgPathSnapshot))) allowed.push(event.id);
    }
    return allowed;
  }

  async listSubmissions(query: SubmissionListQuery, actorId: string): Promise<SubmissionPage> {
    if (!this.repository) return this.store.listSubmissionsPage(query, actorId);
    const actor = await this.actor(actorId);
    const access = await this.adminAccess(actor);
    if (!access) {
      if (query.subjectId && query.subjectId !== actor.id) return { items: [], pageInfo: { page: query.page ?? 1, pageSize: query.pageSize ?? 20, total: 0, totalPages: 0, hasNext: false, hasPrevious: false } };
      return this.repository.submissions.list({ ...query, subjectId: actor.id });
    }
    const eventIds = await this.accessibleEventIds(access);
    return this.repository.submissions.list({ ...query, ...(eventIds ? { eventIds } : {}), ...(access.level === 'GLOBAL' ? {} : { scopeOrgPaths: access.scopeOrgPaths }) });
  }

  async listAudits(query: AuditListQuery, actorId: string): Promise<AuditPage> {
    if (!this.repository) return this.store.listAuditsPage(query, actorId);
    const actor = await this.actor(actorId);
    const access = await this.adminAccess(actor);
    if (!access) return this.store.listAuditsPage(query, actorId);
    return this.repository.audits.list({ ...query, ...(access.level === 'GLOBAL' ? {} : { scopeOrgPaths: access.scopeOrgPaths, viewerId: actorId }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.repository?.close();
  }
}
