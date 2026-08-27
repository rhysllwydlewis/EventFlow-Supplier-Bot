import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { ComplianceAssessment } from '../domain/compliance-assessment.js';
import type { ShadowProfile } from '../domain/shadow-profile.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';

const responseSchema = z.object({
  supplierId: z.string().min(1),
  slug: z.string().min(1),
  status: z.literal('draft'),
  ownershipStatus: z.literal('unclaimed'),
  created: z.boolean(),
  idempotent: z.boolean(),
});

export type EventFlowIngestionResult =
  | { status: 'disabled' | 'not_configured' | 'ineligible'; reason: string }
  | { status: 'created' | 'existing'; supplierId: string; slug: string }
  | { status: 'conflict' | 'failed'; reason: string };

function integrationConfigured(): boolean {
  return Boolean(env.EVENTFLOW_INTERNAL_BASE_URL && env.EVENTFLOW_BOT_HMAC_SECRET);
}

function endpointUrl(): string {
  const base = new URL(env.EVENTFLOW_INTERNAL_BASE_URL!);
  return new URL('/api/v1/internal/supplier-bot/suppliers', base).href;
}

function signature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export async function ingestShadowProfileToEventFlow(input: {
  profile: ShadowProfile;
  compliance: ComplianceAssessment;
  publishingEnabled: boolean;
}): Promise<EventFlowIngestionResult> {
  if (!input.publishingEnabled) {
    return { status: 'disabled', reason: 'publishing_disabled' };
  }
  if (!input.compliance.publicationEligible) {
    return { status: 'ineligible', reason: 'compliance_not_publication_eligible' };
  }
  if (!integrationConfigured()) {
    return { status: 'not_configured', reason: 'eventflow_integration_not_configured' };
  }
  if (input.profile.businessName.length > 100) {
    return { status: 'ineligible', reason: 'business_name_exceeds_eventflow_limit' };
  }

  const payload = {
    candidateId: input.profile.candidateId,
    businessName: input.profile.businessName,
    category: input.profile.category,
    location: input.profile.location,
    website: input.profile.website,
    description: input.profile.description,
    publicEmail: input.profile.publicEmail,
    publicPhone: input.profile.publicPhone && input.profile.publicPhone.length <= 20
      ? input.profile.publicPhone
      : null,
    services: input.profile.services,
    packages: input.profile.packages,
    advertisedPrices: input.profile.advertisedPrices,
    // Media remains provenance-controlled draft acquisition data on EventFlow.
    // The receiver does not treat these references as proof of publication rights.
    coverImage: input.profile.coverImage,
    images: input.profile.images,
    mediaEvidence: input.profile.mediaEvidence,
    publicationQuality: input.profile.publicationQuality,
    dataConfidence: input.profile.dataConfidence,
    complianceStatus: input.compliance.status,
    compliancePolicyVersion: input.compliance.policyVersion,
    generatedAt: input.profile.generatedAt,
    generatorVersion: input.profile.generatorVersion,
  };
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

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
    const responseBody = await response.json().catch(() => ({})) as Record<string, unknown>;

    if (response.status === 409) {
      const reason = typeof responseBody.error === 'string' ? responseBody.error : 'supplier_conflict';
      await recordAuditEvent('eventflow-ingestion', 'eventflow.ingestion_conflict', {
        candidateId: input.profile.candidateId,
        reason,
      });
      return { status: 'conflict', reason };
    }
    if (!response.ok) {
      const reason = typeof responseBody.error === 'string'
        ? responseBody.error
        : `eventflow_http_${response.status}`;
      throw new Error(reason);
    }

    const parsed = responseSchema.parse(responseBody);
    await recordAuditEvent('eventflow-ingestion', 'eventflow.ingestion_succeeded', {
      candidateId: input.profile.candidateId,
      supplierId: parsed.supplierId,
      created: parsed.created,
    });
    return {
      status: parsed.created ? 'created' : 'existing',
      supplierId: parsed.supplierId,
      slug: parsed.slug,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'eventflow_ingestion_failed';
    logger.error({ err: error, candidateId: input.profile.candidateId }, 'EventFlow ingestion failed');
    await recordAuditEvent('eventflow-ingestion', 'eventflow.ingestion_failed', {
      candidateId: input.profile.candidateId,
      reason,
    }).catch(() => undefined);
    return { status: 'failed', reason };
  } finally {
    clearTimeout(timeout);
  }
}
