import { setCandidateStatus } from '../repositories/candidate.repository.js';
import { recordAuditEvent } from '../repositories/audit.repository.js';
import { addSuppression } from '../repositories/suppression.repository.js';
import { deleteShadowProfile, getShadowProfile } from '../repositories/shadow-profile.repository.js';
import { canonicalDomain } from '../utils/url.js';

// An operator reviewing the Shadow profile table needs a way to say "not
// this one" -- a candidate that's technically real and compliant but just
// isn't the right fit. This removes it from the review list immediately
// and, since simply deleting the shadow profile alone would leave the
// domain to be rediscovered and reprocessed on the very next discovery
// cycle, permanently suppresses it from both future crawling and
// publication -- the same do_not_crawl/do_not_list mechanism an operator
// would otherwise have to set up by hand.
export async function rejectShadowProfile(candidateId: string, actor: string): Promise<void> {
  const profile = await getShadowProfile(candidateId);
  if (!profile) {
    throw new Error('Shadow profile not found');
  }

  const domain = canonicalDomain(profile.website);
  await Promise.all([
    addSuppression({
      key: domain,
      type: 'do_not_crawl',
      reason: 'operator_rejected_from_shadow_review',
      permanent: true,
      createdBy: actor,
    }),
    addSuppression({
      key: domain,
      type: 'do_not_list',
      reason: 'operator_rejected_from_shadow_review',
      permanent: true,
      createdBy: actor,
    }),
  ]);
  await deleteShadowProfile(candidateId);
  await setCandidateStatus(candidateId, 'rejected');
  await recordAuditEvent(actor, 'shadow_profile.rejected', {
    candidateId,
    businessName: profile.businessName,
    canonicalDomain: domain,
  });
}
