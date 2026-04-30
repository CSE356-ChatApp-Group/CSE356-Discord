/**
 * WebSocket fanout payloads for message:* events — adds publishedAt (server clock
 * after Redis accepts the publish) for throughput / grading probes.
 */


export function isMessageFanoutEvent(event: string): boolean {
  return (
    event === 'message:created'
    || event === 'message:updated'
    || event === 'message:deleted'
  );
}

export function messageFanoutEnvelope(event: string, data: unknown) {
  return {
    event,
    data,
    publishedAt: new Date().toISOString(),
  };
}

export function wrapFanoutPayload(event: string, data: unknown) {
  return isMessageFanoutEvent(event) ? messageFanoutEnvelope(event, data) : { event, data };
}

export function fanoutPublishedAt(payload: { publishedAt?: string }): string | undefined {
  return typeof payload.publishedAt === 'string' ? payload.publishedAt : undefined;
}
