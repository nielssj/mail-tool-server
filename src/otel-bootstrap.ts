import { metrics } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { defaultResource, detectResources, envDetector } from '@opentelemetry/resources';

/**
 * Deploy-time-only preload module (see docs/metrics.md) — registers the
 * global MeterProvider that @opentelemetry/api's getMeter() calls resolve
 * against, so every mailtool.* instrument stops being a no-op. Never
 * imported by application code, npm start/dev, or tests; only ever loaded
 * via `node --import` from the runtime image's CMD.
 *
 * PrometheusExporter starts its own HTTP server (default port 9464, path
 * /metrics) for a collector to scrape — it does not touch the app's own
 * Fastify servers on 3000/3001. This is pull-based Prometheus exposition,
 * not a push exporter: nothing here sends data anywhere on its own.
 *
 * Resource attributes (service.name etc.) come from OTEL_SERVICE_NAME /
 * OTEL_RESOURCE_ATTRIBUTES via envDetector, merged over the SDK's fallback
 * resource — deliberately not hardcoded here. MeterProvider doesn't apply
 * env-based resource detection on its own (that's NodeSDK's job, which this
 * repo intentionally doesn't depend on), so it's done explicitly below.
 */
const resource = defaultResource().merge(detectResources({ detectors: [envDetector] }));
const exporter = new PrometheusExporter({ port: 9464 });
metrics.setGlobalMeterProvider(new MeterProvider({ resource, readers: [exporter] }));
