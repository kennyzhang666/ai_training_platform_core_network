import { Injectable } from '@nestjs/common';

type RouteMetric = { requests: number; errors: number; totalDurationMs: number; maxDurationMs: number };

export interface PlatformMetricsSnapshot {
  schemaVersion: '1.0';
  generatedAt: string;
  uptimeSeconds: number;
  requests: {
    total: number;
    successful: number;
    clientErrors: number;
    serverErrors: number;
  };
  latencyMs: {
    count: number;
    total: number;
    max: number;
    p50: number;
    p95: number;
  };
  routes: Record<string, RouteMetric>;
}

/**
 * Small process-local operational counter set for the v0.7 data path.
 * Values are deliberately aggregates only: no token, source code, query
 * value, employee number, object key or request body is retained.
 */
@Injectable()
export class PlatformMetrics {
  private readonly startedAt = Date.now();
  private totalRequests = 0;
  private successfulRequests = 0;
  private clientErrors = 0;
  private serverErrors = 0;
  private totalDurationMs = 0;
  private maxDurationMs = 0;
  private readonly recentDurations: number[] = [];
  private readonly routeMetrics = new Map<string, RouteMetric>();

  recordRequest(route: string, statusCode: number, durationMs: number): void {
    const safeRoute = route.trim() || 'unknown';
    const safeStatus = Number.isSafeInteger(statusCode) ? statusCode : 500;
    const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs * 100) / 100 : 0;
    this.totalRequests += 1;
    if (safeStatus >= 500) this.serverErrors += 1;
    else if (safeStatus >= 400) this.clientErrors += 1;
    else this.successfulRequests += 1;
    this.totalDurationMs += safeDuration;
    this.maxDurationMs = Math.max(this.maxDurationMs, safeDuration);
    this.recentDurations.push(safeDuration);
    if (this.recentDurations.length > 1000) this.recentDurations.shift();

    // Cap route cardinality so a client cannot grow this diagnostic structure
    // without bound by sending arbitrary URL paths.
    const existing = this.routeMetrics.get(safeRoute);
    if (existing) {
      existing.requests += 1;
      if (safeStatus >= 400) existing.errors += 1;
      existing.totalDurationMs += safeDuration;
      existing.maxDurationMs = Math.max(existing.maxDurationMs, safeDuration);
    } else if (this.routeMetrics.size < 200) {
      this.routeMetrics.set(safeRoute, { requests: 1, errors: safeStatus >= 400 ? 1 : 0, totalDurationMs: safeDuration, maxDurationMs: safeDuration });
    }
  }

  snapshot(): PlatformMetricsSnapshot {
    const sorted = [...this.recentDurations].sort((left, right) => left - right);
    const percentile = (fraction: number): number => {
      if (!sorted.length) return 0;
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
    };
    return {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)),
      requests: { total: this.totalRequests, successful: this.successfulRequests, clientErrors: this.clientErrors, serverErrors: this.serverErrors },
      latencyMs: { count: this.totalRequests, total: Math.round(this.totalDurationMs * 100) / 100, max: this.maxDurationMs, p50: percentile(0.5), p95: percentile(0.95) },
      routes: Object.fromEntries([...this.routeMetrics.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };
  }
}
