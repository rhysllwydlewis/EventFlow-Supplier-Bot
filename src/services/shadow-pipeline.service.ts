import type { Candidate } from '../domain/candidate.js';
import { crawlSupplierSite } from '../crawler/site-crawler.js';
import { createEvidenceFragment } from '../evidence/evidence.js';
import { extractBasicFacts } from '../extraction/basic-extractor.js';
import { saveEvidenceFragments } from '../repositories/evidence.repository.js';
import { saveShadowProfile } from '../repositories/shadow-profile.repository.js';
import { setCandidateStatus } from '../repositories/candidate.repository.js';
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

    const profile = composeDeterministicShadowProfile({
      candidate,
      extraction,
      evidenceIds: evidence.map(item => item.id),
    });
    const quality = scoreShadowProfile(profile);
    const finalProfile = await saveShadowProfile({ ...profile, publicationQuality: quality.total });
    await setCandidateStatus(candidate.id, 'shadow_ready');

    return {
      profile: finalProfile,
      quality,
      crawlFailures: crawl.failures,
    };
  } catch (error) {
    await setCandidateStatus(candidate.id, 'quarantined');
    throw error;
  }
}
