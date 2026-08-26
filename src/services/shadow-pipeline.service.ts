import type { Candidate } from '../domain/candidate.js';
import type { SiteCrawlResult } from '../crawler/site-crawler.js';
import { assessBrowserFallback } from '../crawler/browser-fallback.js';
import { crawlSupplierSiteWithBrowser } from '../crawler/browser-renderer.js';
import { crawlSupplierSite } from '../crawler/site-crawler.js';
import { createEvidenceFragment } from '../evidence/evidence.js';
import { extractBasicFacts, type BasicExtraction } from '../extraction/basic-extractor.js';
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

async function completeShadowProfile(
  candidate: Candidate,
  crawl: SiteCrawlResult,
  extraction: BasicExtraction,
  crawlMethod: 'http' | 'browser',
) {
  await setCandidateStatus(candidate.id, 'extracting');
  const evidence = extraction.pageText.map(page => createEvidenceFragment({
    candidateId: candidate.id,
    sourceUrl: page.url,
    sourceType: 'supplier_website',
    rawForHash: page.text,
    excerpt: page.text.slice(0, 2_000),
    metadata: { crawlMethod },
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
      crawlMethod,
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
      crawlMethod,
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
    crawlMethod,
  };
}

export async function runShadowPipeline(candidate: Candidate) {
  await setCandidateStatus(candidate.id, 'crawling');
  try {
    const crawl = await crawlSupplierSite(candidate.canonicalUrl, 8);
    await setCandidateStatus(candidate.id, 'crawled');
    const extraction = extractBasicFacts(crawl);
    const fallback = assessBrowserFallback(crawl, extraction);
    if (fallback.required) {
      return {
        browserFallbackRequired: true,
        browserFallbackReason: fallback.reason,
        crawlFailures: crawl.failures,
      };
    }
    return completeShadowProfile(candidate, crawl, extraction, 'http');
  } catch (error) {
    await setCandidateStatus(candidate.id, 'quarantined');
    throw error;
  }
}

export async function runBrowserShadowPipeline(candidate: Candidate) {
  await setCandidateStatus(candidate.id, 'browser_crawling');
  try {
    const crawl = await crawlSupplierSiteWithBrowser(candidate.canonicalUrl);
    await setCandidateStatus(candidate.id, 'crawled');
    const extraction = extractBasicFacts(crawl);
    return completeShadowProfile(candidate, crawl, extraction, 'browser');
  } catch (error) {
    await setCandidateStatus(candidate.id, 'quarantined');
    throw error;
  }
}
