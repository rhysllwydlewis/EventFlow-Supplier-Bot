import { crawlSupplierSite } from '../crawler/site-crawler.js';
import { createEvidenceFragment } from '../evidence/evidence.js';
import { extractBasicFacts } from '../extraction/basic-extractor.js';
import { saveEvidenceFragments } from '../repositories/evidence.repository.js';
import { setCandidateStatus } from '../repositories/candidate.repository.js';

export async function crawlAndExtractCandidate(candidate: { id: string; canonicalUrl: string }) {
  await setCandidateStatus(candidate.id, 'crawling');
  try {
    const crawl = await crawlSupplierSite(candidate.canonicalUrl, 8);
    await setCandidateStatus(candidate.id, 'crawled');
    const extraction = extractBasicFacts(crawl);

    const evidence = extraction.pageText.map(page => createEvidenceFragment({
      candidateId: candidate.id,
      sourceUrl: page.url,
      sourceType: 'supplier_website',
      rawForHash: page.text,
      excerpt: page.text.slice(0, 2_000),
      metadata: {},
    }));
    await saveEvidenceFragments(evidence);
    await setCandidateStatus(candidate.id, 'ready_for_quality');

    return {
      crawl: {
        pageCount: crawl.pages.length,
        failures: crawl.failures,
      },
      extraction: {
        emails: extraction.emails,
        phones: extraction.phones,
        advertisedPrices: extraction.advertisedPrices,
        jsonLdCount: extraction.jsonLd.length,
      },
      evidenceCount: evidence.length,
    };
  } catch (error) {
    await setCandidateStatus(candidate.id, 'quarantined');
    throw error;
  }
}
