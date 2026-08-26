import type { ShadowProfile } from '../domain/shadow-profile.js';

export interface QualityBreakdown {
  identity: number;
  evidence: number;
  contact: number;
  commercialData: number;
  content: number;
  total: number;
  reasons: string[];
}

export function scoreShadowProfile(profile: ShadowProfile): QualityBreakdown {
  let identity = 0;
  let evidence = 0;
  let contact = 0;
  let commercialData = 0;
  let content = 0;
  const reasons: string[] = [];

  if (profile.businessName && profile.businessName !== profile.website) identity += 20;
  else reasons.push('weak_business_identity');
  if (profile.category && profile.category !== 'Other') identity += 10;
  else reasons.push('weak_category');
  if (profile.location) identity += 10;
  else reasons.push('missing_location');

  evidence = Math.min(20, profile.evidenceIds.length * 5);
  if (evidence < 10) reasons.push('limited_evidence');

  if (profile.publicEmail) contact += 5;
  if (profile.publicPhone) contact += 5;
  if (contact === 0) reasons.push('missing_public_contact');

  if (profile.advertisedPrices.length) commercialData += 10;
  if (profile.packages.length) commercialData += 5;
  if (commercialData === 0) reasons.push('missing_commercial_data');

  if (profile.description.length >= 120) content += 10;
  if (profile.services.length) content += 5;
  if (content < 15) reasons.push('thin_content');

  const total = Math.min(100, identity + evidence + contact + commercialData + content);
  return { identity, evidence, contact, commercialData, content, total, reasons };
}
