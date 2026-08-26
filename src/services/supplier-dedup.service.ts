import type { ShadowProfile } from '../domain/shadow-profile.js';
import type { DedupAssessment, SupplierIdentity } from '../domain/supplier-identity.js';
import { canonicalDomain } from '../utils/url.js';

export const DEDUP_POLICY_VERSION = 'supplier-identity-v1';

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

export function normalizeBusinessName(value: string): string {
  const normalized = clean(value) || value.trim().toLowerCase();
  const stripped = normalized.replace(/\b(limited|ltd|plc|llp|company|co)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped || normalized;
}

export function normalizeEmail(value: string | null): string | null {
  return value ? value.trim().toLowerCase() : null;
}

export function normalizePhone(value: string | null): string | null {
  if (!value) return null;
  let digits = value.replace(/\D+/g, '');
  if (digits.startsWith('440') && digits.length >= 12) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('44') && digits.length >= 11) digits = `0${digits.slice(2)}`;
  return digits.length >= 9 ? digits : null;
}

export function toSupplierIdentity(profile: ShadowProfile): SupplierIdentity {
  return {
    candidateId: profile.candidateId,
    canonicalDomain: canonicalDomain(profile.website),
    normalizedName: normalizeBusinessName(profile.businessName),
    normalizedLocation: clean(profile.location),
    normalizedCategory: clean(profile.category),
    normalizedEmail: normalizeEmail(profile.publicEmail),
    normalizedPhone: normalizePhone(profile.publicPhone),
    profileGeneratedAt: profile.generatedAt,
    indexedAt: new Date().toISOString(),
  };
}

function compareIdentity(candidate: SupplierIdentity, existing: SupplierIdentity) {
  const signals: string[] = [];
  let score = 0;
  const sameEmail = Boolean(candidate.normalizedEmail && candidate.normalizedEmail === existing.normalizedEmail);
  const samePhone = Boolean(candidate.normalizedPhone && candidate.normalizedPhone === existing.normalizedPhone);
  const sameName = candidate.normalizedName === existing.normalizedName;
  const sameLocation = Boolean(candidate.normalizedLocation && candidate.normalizedLocation === existing.normalizedLocation);
  const sameCategory = Boolean(candidate.normalizedCategory && candidate.normalizedCategory === existing.normalizedCategory);

  if (sameEmail) { score += 45; signals.push('same_public_email'); }
  if (samePhone) { score += 45; signals.push('same_public_phone'); }
  if (sameName) { score += 30; signals.push('same_business_name'); }
  if (sameLocation) { score += 15; signals.push('same_location'); }
  if (sameCategory) { score += 10; signals.push('same_category'); }
  if (candidate.canonicalDomain === existing.canonicalDomain) { score += 100; signals.push('same_domain'); }

  const strong = candidate.canonicalDomain === existing.canonicalDomain
    || (sameName && sameEmail)
    || (sameName && samePhone)
    || (sameEmail && samePhone && sameLocation);
  const probable = !strong && (sameEmail || samePhone || (sameName && (sameLocation || sameCategory)));
  return { score: Math.min(100, score), signals, strong, probable };
}

export function assessSupplierDuplicate(profile: ShadowProfile, existing: SupplierIdentity[]): DedupAssessment {
  const candidate = toSupplierIdentity(profile);
  let best: { identity: SupplierIdentity; score: number; signals: string[]; strong: boolean; probable: boolean } | null = null;
  for (const identity of existing) {
    if (identity.candidateId === candidate.candidateId) continue;
    const compared = compareIdentity(candidate, identity);
    if (!best || compared.score > best.score) best = { identity, ...compared };
  }
  const decision: DedupAssessment['decision'] = best?.strong ? 'strong_duplicate' : best?.probable ? 'probable_duplicate' : 'distinct';
  return {
    candidateId: candidate.candidateId,
    decision,
    matchedCandidateId: decision === 'distinct' ? null : best?.identity.candidateId ?? null,
    score: best?.score ?? 0,
    signals: best?.signals ?? [],
    policyVersion: DEDUP_POLICY_VERSION,
    assessedAt: new Date().toISOString(),
  };
}
