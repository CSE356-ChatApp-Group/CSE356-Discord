'use strict';

/**
 * OpenTelemetry SDK bootstrap.
 *
 * Must be required BEFORE any other module so instrumentation patches load first.
 * Exports a named tracer for manual span creation.
 *
 * Traces are sent to Grafana Tempo via OTLP/HTTP.
 */

const { trace, context } = require('@opentelemetry/api');

const enabled = String(process.env.OTEL_ENABLED || '').trim().toLowerCase() === 'true';
const isProduction = process.env.NODE_ENV === 'production';
const parsedRatio = Number(process.env.OTEL_TRACES_SAMPLE_RATIO || (isProduction ? '0.1' : '1'));
const traceSampleRatio = Number.isFinite(parsedRatio)
  ? Math.max(0, Math.min(1, parsedRatio))
  : (isProduction ? 0.1 : 1);

if (enabled) {
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
  const {
    BatchSpanProcessor,
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
  } = require('@opentelemetry/sdk-trace-base');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.LOG_SERVICE_NAME || 'chatapp-api',
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(traceSampleRatio),
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://tempo:4318/v1/traces',
        }),
      ),
    ],
  });

  provider.register();
}

const tracer = trace.getTracer('chatapp-api');

module.exports = { tracer, context, trace, otelEnabled: enabled, traceSampleRatio };
