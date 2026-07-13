import { metrics, type Meter } from '@opentelemetry/api';

/**
 * Thin factory over the global OTel metrics API — mirrors
 * utils/logger.ts's createLogger(config) factory: every module gets its
 * meter through here, never calls the OTel API directly. Safe to call and
 * record against with no MeterProvider registered — @opentelemetry/api
 * returns a no-op Meter in that case, so instrumentation never throws
 * before a collection platform is wired up (see docs/otel-metrics-proposal.md).
 */
export const getMeter = (name: string, version?: string): Meter =>
  metrics.getMeter(name, version);
