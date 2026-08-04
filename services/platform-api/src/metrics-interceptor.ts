import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { PlatformMetrics } from './metrics';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(@Inject(PlatformMetrics) private readonly metrics: PlatformMetrics) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<any>();
    const reply = http.getResponse<any>();
    const metrics = this.metrics;
    const started = process.hrtime.bigint();
    let failed = false;
    let recorded = false;
    // Only retain framework-provided route templates. A raw URL fallback could
    // put employee IDs, object keys or query values into the aggregate labels.
    const route = typeof request?.routeOptions?.url === 'string'
      ? request.routeOptions.url
      : typeof request?.routerPath === 'string' ? request.routerPath : 'unknown';
    const record = () => {
      if (recorded) return;
      recorded = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const observedStatus = Number(reply?.statusCode ?? (failed ? 500 : 200));
      // Nest/Fastify may throw before setting a response status. Preserve a
      // real 4xx status from the exception filter, but classify an untouched
      // 2xx response on an error path as a server error.
      const statusCode = failed && observedStatus < 400 ? 500 : observedStatus;
      metrics.recordRequest(route, statusCode, durationMs);
    };
    // `finalize` is intentionally avoided here: with Fastify's response
    // stream it can defer completion of the Nest request observable. The tap
    // callbacks cover normal, empty and error responses while preserving the
    // response lifecycle.
    return next.handle().pipe(tap({
      next: record,
      complete: record,
      error: () => {
        failed = true;
        // The exception filter sets Fastify's status after the RxJS error
        // notification. Defer one turn so a 4xx remains a client error
        // instead of being misclassified as a 500.
        setImmediate(record);
      },
    }));
  }
}
