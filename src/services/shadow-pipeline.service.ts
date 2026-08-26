import type { Candidate } from '../domain/candidate.js';
import { crawlSupplierSite } from '../crawler/site-crawler.js';
import { createEvidenceFragment } from '../evidence/evidence.js';
import { extractBasicFacts } from '../extraction/basic-extractor.js';
import { getCampaign } from '../repositories/campaign.repository.js';
import { saveComplianceAssessment } from '../repositories/compliance-assessment.repository.js';
import { saveEvidenceFragments } from '../repositories/evidence.repository.js';
import { saveShadowProfile } from '../repositories/shadow-profile.repository.js';
import { setCandidateStatus } from '../repositories/candidate.repository.js';
import { getSettings } from '../repositories/settings.repository.js';
import { enrichShadowProfileWithAi } from './ai-enrichment.service.js';
import {
  applyDescriptionComplianceFallback,
  assessShadowProfileCompliance,
  effectiveMinimumPublicationQuality,
} from './compliance.service.js';
import { assessAndPersistSupplierDuplicate } from './supplier-identity-reconciliation.service.js';
import { composeDeterministicShadowProfile } from './shadow-profile-composer.service.js';
import { scoreShadowProfile } from './quality.service.js';

export async function runShadowPipeline(candidate: Candidate) {
  await setCandidateStatus(candidate.id, 'crawling');
  try {
    const crawl = await crawlSupplierSite(candidate.canonicalUrl, 8);
    await setCandidateStatus(candidate.id, 'crawled');
    const extraction = extractBasicFacts(crawl);
    await setCandidateStatus(candidate.id, 'extracting');

    const evidence = extraction.pageText.map(page => createEvidenceFragment({
      candidateId: candidate.id,
      sourceUrl: page.url,
      sourceType: 'supplier_website',
      rawForHash: page.text,
      excerpt: page.text.slice(0, 2_000),
      metadata: {},
    }));
    await saveEvidenceFragments(evidence);

    const deterministicProfile = composeDeterministicShadowProfile({
      candidate,
      extraction,
      evidenceIds: evidence.map(item => item.id),
    });
    const [settings, campaign] = await Promise.all([
      getSettings(),
      getCampaign(candidate.campaignId),
    ]);
    const minimumPublicationQuality = effectiveMinimumPublicationQuality(
      settings.minimumPublicationQuality,
      campaign?.minimumPublicationQuality,
    );
    const ai = await enrichShadowProfileWithAi({
      profile: deterministicProfile,
      evidence,
      hardBudgetGbp: settings.hardAiSpendGbpPerDay,
    });

    const compliantDescription = applyDescriptionComplianceFallback({
      profile: ai.profile,
      deterministicProfile,
      evidence,
    });
    const quality = scoreShadowProfile(compliantDescription.profile);
    const candidateProfile = {
      ...compliantDescription.profile,
      publicationQuality: quality.total,
    };

    const dedup = await assessAndPersistSupplierDuplicate(candidateProfile);
    if (dedup.assessment.decision === 'strong_duplicate') {
      await setCandidateStatus(candidate.id, 'duplicate');
      return {
        duplicate: true,
        dedup: dedup.assessment,
        quality,
        ai: { status: ai.status, model: ai.model, responseId: ai.responseId },
        crawlFailures: crawl.failures,
      };
    }

    const finalProfile = await saveShadowProfile(candidateProfile);
    const compliance = await saveComplianceAssessment(assessShadowProfileCompliance({
      profile: finalProfile,
      evidence,
      minimumPublicationQuality,
      descriptionFallbackApplied: compliantDescription.fallbackApplied,
    }));

    if (dedup.assessment.decision === 'probable_duplicate') {
      await setCandidateStatus(candidate.id, 'quarantined');
      return {
        profile: finalProfile,
        quality,
        compliance,
        dedup: dedup.assessment,
        quarantined: true,
        ai: { status: ai.status, model: ai.model, responseId: ai.responseId },
        crawlFailures: crawl.failures,
      };
    }

    await setCandidateStatus(candidate.id, 'shadow_ready');
    return {
      profile: finalProfile,
      quality,
      compliance,
      dedup: dedup.assessment,
      ai: { status: ai.status, model: ai.model, responseId: ai.responseId },
      crawlFailures: crawl.failures,
    };
  } catch (error) {
    await setCandidateStatus(candidate.id, 'quarantined');
    throw error;
  }
}
