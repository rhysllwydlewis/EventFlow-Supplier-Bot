import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const responseSchema = z.object({ exists: z.boolean() });

function integrationConfigured(): boolean {
  return Boolean(env.EVENTFLOW_INTERNAL_BASE_URL && env.EVENTFLOW_BOT_HMAC_SECRET);
}

function endpointUrl(): string {
  const base = new URL(env.EVENTFLOW_INTERNAL_BASE_URL!);
  return new URL('/api/v1/internal/supplier-bot/suppliers/lookup', base).href;
}

function signature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// Checked at discovery time, before any crawl or AI spend, so the bot never
// builds a full profile for a business that already has a real EventFlow
// supplier record -- whether that's a business that signed up directly
// (this bot has no other way to ever learn about those; published_suppliers
// only ever gets a row from this bot's own successful publishes) or drift
// this bot's own bookkeeping missed. The server-side match is by hostname,
// matching every other duplicate-prevention check this bot already has
// (published_suppliers, discovery.service.ts's own check) -- see the
// comment on EventFlow's lookup route for why that's the intended
// granularity here, not the ingestion route's stricter per-page check.
//
// Best-effort and fail-open: if EventFlow is unreachable, misconfigured, or
// returns anything unexpected, discovery must not grind to a halt over a
// lookup that exists purely to save budget -- it proceeds exactly as it did
// before this check existed, and the ingestion route's own conflict check
// remains the authoritative backstop against ever actually publishing a
// duplicate, regardless of what this check does or doesn't catch.
export async function eventFlowAlreadyHasSupplierForDomain(domain: string): Promise<boolean> {
  if (!integrationConfigured()) {
    return false;
  }

  const payload = { domain };
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(endpointUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eventflow-bot-timestamp': timestamp,
        'x-eventflow-bot-signature': `sha256=${signature(env.EVENTFLOW_BOT_HMAC_SECRET!, timestamp, body)}`,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status, domain },
        'EventFlow supplier lookup returned a non-OK status; proceeding as if not found',
      );
      return false;
    }
    const parsed = responseSchema.parse(await response.json());
    return parsed.exists;
  } catch (error) {
    logger.warn({ err: error, domain }, 'EventFlow supplier lookup failed; proceeding as if not found');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
