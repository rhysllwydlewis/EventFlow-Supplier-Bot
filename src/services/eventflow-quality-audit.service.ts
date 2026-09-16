import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { ShadowProfile } from '../domain/shadow-profile.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import { eventFlowIngestionResponseSchema } from './eventflow-ingestion.service.js';

const auditGapsSchema = z.object({
  missingCoverImage: z.boolean(),
  missingGalleryImages: z.boolean(),
  missingDescription: z.boolean(),
  missingPhone: z.boolean(),
  missingTags: z.boolean(),
  packagesMissingPhotos: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
});

export const auditQueueItemSchema = z.object({
  supplierId: z.string().min(1),
  candidateId: z.string().nullable(),
  website: z.string().url(),
  slug: z.string(),
  name: z.string(),
  publicationScope: z.string().nullable(),
  publishedUnclaimedAt: z.string().nullable(),
  completenessScore: z.number(),
  gaps: auditGapsSchema,
});
export type AuditQueueItem = z.infer<typeof auditQueueItemSchema>;

const auditQueueResponseSchema = z.object({
  totalPublished: z.number(),
  totalNeedingWork: z.number(),
  queue: z.array(auditQueueItemSchema),
});

export type AuditQueueFetchResult =
  | { status: 'not_configured'; reason: string }
  | { status: 'fetched'; totalPublished: number; totalNeedingWork: number; queue: AuditQueueItem[] }
  | { status: 'failed'; reason: string };

export type EventFlowRefreshResult =
  | { status: 'not_configured'; reason: string }
  | { status: 'refreshed'; supplierId: string; slug: string }
  | { status: 'conflict' | 'failed'; reason: string };

function integrationConfigured(): boolean {
  return Boolean(env.EVENTFLOW_INTERNAL_BASE_URL && env.EVENTFLOW_BOT_HMAC_SECRET);
}

function auditQueueUrl(): string {
  const base = new URL(env.EVENTFLOW_INTERNAL_BASE_URL!);
  return new URL('/api/v1/internal/supplier-bot/suppliers/audit-queue', base).href;
}

function refreshUrl(): string {
  const base = new URL(env.EVENTFLOW_INTERNAL_BASE_URL!);
  return new URL('/api/v1/internal/supplier-bot/suppliers', base).href;
}

function signature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// Read-only: pulls the worst-first batch of published unclaimed profiles
// with real, already-computed data gaps from EventFlow's own audit-queue
// endpoint (routes/supplier-profile-safe.js). Never writes anything itself
// -- see refreshEventFlowSupplierData below for the write path.
export async function fetchAuditQueue(
  input: { limit?: number; excludeSupplierIds?: string[] } = {},
): Promise<AuditQueueFetchResult> {
  if (!integrationConfigured()) {
    return { status: 'not_configured', reason: 'eventflow_integration_not_configured' };
  }

  const payload = {
    ...(input.limit ? { limit: input.limit } : {}),
    ...(input.excludeSupplierIds ? { excludeSupplierIds: input.excludeSupplierIds } : {}),
  };
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(auditQueueUrl(), {
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
    if (!response.ok) {
      const reason = typeof responseBody.error === 'string' ? responseBody.error : `eventflow_http_${response.status}`;
      throw new Error(reason);
    }
    const parsed = auditQueueResponseSchema.parse(responseBody);
    return { status: 'fetched', ...parsed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'eventflow_audit_queue_fetch_failed';
    logger.error({ err: error }, 'EventFlow audit-queue fetch failed');
    return { status: 'failed', reason };
  } finally {
    clearTimeout(timeout);
  }
}

// Writes a candidate's full current ShadowProfile back through the same
// idempotent POST /internal/supplier-bot/suppliers path the original
// publish used (routes/supplier-profile-safe.js's managedRefreshPatch is a
// wholesale field replace, not a merge) -- so the caller must always pass a
// complete, valid profile with only the genuinely improved fields changed,
// never a bare partial patch, or every field this call omits gets wiped
// back to empty on EventFlow's side.
//
// publicationScope is deliberately never sent: EventFlow's own
// effectivePublicationScope() keeps an already-published profile's existing
// scope regardless of what a later refresh call includes, so there is
// nothing for this audit-only path to resend (or risk guessing wrong).
export async function refreshEventFlowSupplierData(input: {
  profile: ShadowProfile;
}): Promise<EventFlowRefreshResult> {
  if (!integrationConfigured()) {
    return { status: 'not_configured', reason: 'eventflow_integration_not_configured' };
  }

  const profile = input.profile;
  const payload = {
    candidateId: profile.candidateId,
    businessName: profile.businessName,
    category: profile.category,
    location: profile.location,
    website: profile.website,
    description: profile.description,
    publicEmail: profile.publicEmail,
    publicPhone: profile.publicPhone,
    services: profile.services,
    packages: profile.packages,
    advertisedPrices: profile.advertisedPrices,
    coverImage: profile.coverImage,
    images: profile.images,
    mediaEvidence: profile.mediaEvidence,
    publicationQuality: profile.publicationQuality,
    dataConfidence: profile.dataConfidence,
    generatedAt: profile.generatedAt,
    generatorVersion: profile.generatorVersion,
  };
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(refreshUrl(), {
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

    if (response.status === 409) {
      const reason = typeof responseBody.error === 'string' ? responseBody.error : 'supplier_conflict';
      await recordAuditEvent('eventflow-quality-audit', 'eventflow.quality_refresh_conflict', {
        candidateId: profile.candidateId,
        reason,
      });
      return { status: 'conflict', reason };
    }
    if (!response.ok) {
      const reason = typeof responseBody.error === 'string' ? responseBody.error : `eventflow_http_${response.status}`;
      throw new Error(reason);
    }

    const parsed = eventFlowIngestionResponseSchema.parse(responseBody);
    await recordAuditEvent('eventflow-quality-audit', 'eventflow.quality_refresh_succeeded', {
      candidateId: profile.candidateId,
      supplierId: parsed.supplierId,
      refreshed: parsed.refreshed ?? false,
    });
    return { status: 'refreshed', supplierId: parsed.supplierId, slug: parsed.slug };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'eventflow_quality_refresh_failed';
    logger.error({ err: error, candidateId: profile.candidateId }, 'EventFlow quality-audit refresh failed');
    await recordAuditEvent('eventflow-quality-audit', 'eventflow.quality_refresh_failed', {
      candidateId: profile.candidateId,
      reason,
    }).catch(() => undefined);
    return { status: 'failed', reason };
  } finally {
    clearTimeout(timeout);
  }
}
