'use strict';

/**
 * OpenTelemetry SDK bootstrap.
 *
 * Must be required BEFORE any other module so instrumentation patches load first.
 * Exports a named tracer for manual span creation.
 *
 * Traces are sent to Grafana Tempo via OTLP/HTTP.
 */

const { NodeTracerProvider }    = require('@opentelemetry/sdk-trace-node');
const { BatchSpanProcessor }    = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter }     = require('@opentelemetry/exporter-trace-otlp-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME }      = require('@opentelemetry/semantic-conventions');
const { trace, context }        = require('@opentelemetry/api');

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'chatapp-api',
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

const tracer = trace.getTracer('chatapp-api');

module.exports = { tracer, context, trace };
