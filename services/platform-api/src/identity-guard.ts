import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { AuthenticatedActor, authenticateHeaders, loadIdentityConfig } from './identity';
import { USER_DIRECTORY_REPOSITORY, UserDirectoryRepository } from './user-directory';
import { PlatformStore } from './store';
import { AppUser } from './domain';

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  authenticatedActor?: AuthenticatedActor;
}

export function ssoIdentitySyncIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SSO_IDENTITY_SYNC_INTERVAL_SECONDS?.trim();
  if (!raw) return 300_000;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3_600) {
    throw new Error('SSO_IDENTITY_SYNC_INTERVAL_SECONDS must be an integer between 1 and 3600');
  }
  return seconds * 1_000;
}

/**
 * Request-level identity boundary. Domain controllers keep their existing
 * local actor lookup for compatibility, but the value they see is written by
 * this guard after verification; in production a client-supplied
 * X-Employee-Id is never accepted as proof of identity.
 */
@Injectable()
export class AuthenticatedActorGuard implements CanActivate {
  private readonly config = loadIdentityConfig();
  private readonly syncIntervalMs = ssoIdentitySyncIntervalMs();
  private readonly synchronized = new Map<string, { fingerprint: string; userId: string; synchronizedAt: number }>();
  private readonly syncFlights = new Map<string, Promise<AppUser>>();

  constructor(@Inject(USER_DIRECTORY_REPOSITORY) private readonly repository: UserDirectoryRepository, @Inject(PlatformStore) private readonly store: PlatformStore) {}

  private cachedUser(userId: string): AppUser | undefined {
    try { return this.store.getUser(userId); } catch { return undefined; }
  }

  private assertActive(user: AppUser): AppUser {
    if (user.status !== 'ACTIVE') throw new ForbiddenException('账号已停用');
    return user;
  }

  private async synchronizeActor(actor: AuthenticatedActor): Promise<AppUser> {
    const name = actor.name ?? actor.employeeNo;
    const department = actor.department ?? '';
    const fingerprint = JSON.stringify([name, department]);
    const recent = this.synchronized.get(actor.employeeNo);
    if (recent?.fingerprint === fingerprint && Date.now() - recent.synchronizedAt < this.syncIntervalMs) {
      const cached = this.cachedUser(recent.userId);
      if (cached) return this.assertActive(cached);
    }

    const flightKey = `${actor.employeeNo}\u0000${fingerprint}`;
    const existingFlight = this.syncFlights.get(flightKey);
    if (existingFlight) return existingFlight;
    const operation = this.repository.syncSsoIdentity({ employeeNo: actor.employeeNo, name, department: actor.department })
      .then(({ user }) => {
        this.store.cacheUserSnapshot(user);
        this.synchronized.set(actor.employeeNo, { fingerprint, userId: user.id, synchronizedAt: Date.now() });
        return this.assertActive(user);
      })
      .finally(() => {
        if (this.syncFlights.get(flightKey) === operation) this.syncFlights.delete(flightKey);
      });
    this.syncFlights.set(flightKey, operation);
    return operation;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Match the health route exactly. `endsWith` would also exempt any future
    // route whose path happens to end in `/health`, silently widening the
    // unauthenticated surface.
    const path = request.url?.split('?')[0]?.replace(/\/+$/, '');
    if (request.method === 'OPTIONS' || path === '/api/v1/health') return true;
    const actor = await authenticateHeaders(request.headers, this.config);
    request.authenticatedActor = actor;
    if (actor.authenticationType !== 'LOCAL') {
      const synced = await this.synchronizeActor(actor);
      request.headers['x-employee-id'] = synced.id;
    } else if (!request.headers['x-employee-id']) {
      request.headers['x-employee-id'] = actor.employeeNo;
    }
    return true;
  }
}
