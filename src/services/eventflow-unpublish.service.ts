import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';

export type EventFlowUnpublishResult =
  | { status: 'not_configured'; reason: string }
  | { status: 'unpublished' }
  | { status: 'not_found' | 'not_bot_managed' | 'failed'; reason: string };

function integrationConfigured(): boolean {
  return Boolean(env.EVENTFLOW_INTERNAL_BASE_URL && env.EVENTFLOW_BOT_HMAC_SECRET);
}

function endpointUrl(supplierId: string): string {
  const base = new URL(env.EVENTFLOW_INTERNAL_BASE_URL!);
  return new URL(`/api/v1/internal/supplier-bot/suppliers/${supplierId}/unpublish`, base).href;
}

function signature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// Reverses a past publish for a supplier that turned out not to belong on
// the marketplace at all (wrong region, a directory page mistaken for a
// business) rather than merely having fixable data -- see
// eventflow-ingestion.service.ts's refresh path for the latter. Only ever
// touches EventFlow's side; the caller is responsible for whatever bot-side
// bookkeeping (candidate status, audit trail) applies to why this listing is
// being removed.
export async function unpublishFromEventFlow(input: {
  candidateId: string;
  supplierId: string;
  reason: string;
}): Promise<EventFlowUnpublishResult> {
  if (!integrationConfigured()) {
    return { status: 'not_configured', reason: 'eventflow_integration_not_configured' };
  }

  const body = JSON.stringify({ reason: input.reason });
  const timestamp = String(Date.now());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(endpointUrl(input.supplierId), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eventflow-bot-timestamp': timestamp,
        'x-eventflow-bot-signature': `sha256=${signature(env.EVENTFLOW_BOT_HMAC_SECRET!, timestamp, body)}`,
      },
      body,
      signal: controller.signal,
    });
    const responseBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (response.status === 404) {
      return { status: 'not_found', reason: 'eventflow_supplier_not_found' };
    }
    if (response.status === 409) {
      return { status: 'not_bot_managed', reason: 'eventflow_supplier_not_bot_managed' };
    }
    if (!response.ok) {
      const reason = typeof responseBody.error === 'string'
        ? responseBody.error
        : `eventflow_http_${response.status}`;
      throw new Error(reason);
    }

    await recordAuditEvent('eventflow-unpublish', 'eventflow.unpublish_succeeded', {
      candidateId: input.candidateId,
      supplierId: input.supplierId,
      reason: input.reason,
    });
    return { status: 'unpublished' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'eventflow_unpublish_failed';
    logger.error({ err: error, candidateId: input.candidateId, supplierId: input.supplierId }, 'EventFlow unpublish failed');
    await recordAuditEvent('eventflow-unpublish', 'eventflow.unpublish_failed', {
      candidateId: input.candidateId,
      supplierId: input.supplierId,
      reason,
    }).catch(() => undefined);
    return { status: 'failed', reason };
  } finally {
    clearTimeout(timeout);
  }
}
