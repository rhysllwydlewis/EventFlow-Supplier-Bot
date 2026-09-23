import type { Candidate } from '../domain/candidate.js';
import type { ComplianceAssessment } from '../domain/compliance-assessment.js';

export function applyIdentityDedupGate(
  assessment: ComplianceAssessment,
  candidate: Candidate | null | undefined,
): ComplianceAssessment {
  const decision = candidate?.dedupDecision;
  if (decision === 'distinct') return assessment;

  const reasons = new Set(assessment.reasons);
  // Dedup review/pending must never *downgrade* a status the underlying
  // compliance assessment already earned on its own (content/media/category
  // reasons unrelated to dedup) -- only strong_duplicate is allowed to force
  // 'block' below.
  let status: ComplianceAssessment['status'] = assessment.status === 'block' ? 'block' : 'review';
  if (decision === 'strong_duplicate') {
    reasons.add('strong_supplier_duplicate');
    status = 'block';
  } else if (decision === 'probable_duplicate') {
    reasons.add('probable_supplier_duplicate');
  } else {
    reasons.add('identity_dedup_pending');
  }

  return {
    ...assessment,
    status,
    publicationEligible: false,
    seoIndexEligible: false,
    reasons: [...reasons],
  };
}
