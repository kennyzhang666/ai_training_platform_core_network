import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AuthenticatedActor, authenticateHeaders, loadIdentityConfig } from './identity';
import { USER_DIRECTORY_REPOSITORY, UserDirectoryRepository } from './user-directory';
import { PlatformStore } from './store';

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  authenticatedActor?: AuthenticatedActor;
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

  constructor(@Inject(USER_DIRECTORY_REPOSITORY) private readonly repository: UserDirectoryRepository, @Inject(PlatformStore) private readonly store: PlatformStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.method === 'OPTIONS' || request.url?.endsWith('/health')) return true;
    const actor = await authenticateHeaders(request.headers, this.config);
    request.authenticatedActor = actor;
    if (actor.authenticationType !== 'LOCAL') {
      const synced = (await this.repository.syncSsoIdentity({ employeeNo: actor.employeeNo, name: actor.name ?? actor.employeeNo, department: actor.department })).user;
      this.store.cacheUserSnapshot(synced);
      request.headers['x-employee-id'] = synced.id;
    } else if (!request.headers['x-employee-id']) {
      request.headers['x-employee-id'] = actor.employeeNo;
    }
    return true;
  }
}
