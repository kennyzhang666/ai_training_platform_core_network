import { Inject, Injectable, CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { from, Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { PlatformStore } from './store';

/**
 * A request is not successful until an asynchronous PlatformStore write has
 * committed.  The file adapter has a no-op flush, while the PostgreSQL
 * adapter uses this boundary to surface transaction failures to the caller
 * instead of acknowledging a write that is still only in process memory.
 */
@Injectable()
export class PlatformPersistenceInterceptor implements NestInterceptor {
  constructor(@Inject(PlatformStore) private readonly store: PlatformStore) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      switchMap((value) => from(this.store.flushPersistence().then(() => value))),
    );
  }
}
