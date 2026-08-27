import type { Candidate } from '../domain/candidate.js';
import type { EvidenceFragment } from '../evidence/evidence.js';
import { listCandidates } from '../repositories/candidate.repository.js';
import { listEvidenceForCandidateIds } from '../repositories/evidence.repository.js';
import { getShadowProfilesForCandidateIds } from '../repositories/shadow-profile.repository.js';

function uniqueUrls(values: string[], max: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, max);
}

function pagesByCandidate(evidence: EvidenceFragment[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const fragment of evidence) {
    const current = result.get(fragment.candidateId) ?? [];
    current.push(fragment.sourceUrl);
    result.set(fragment.candidateId, current);
  }
  for (const [candidateId, urls] of result) {
    result.set(candidateId, uniqueUrls(urls, 25));
  }
  return result;
}

function auditCandidate(
  candidate: Candidate,
  pageMap: Map<string, string[]>,
  profiles: Map<string, Awaited<ReturnType<typeof getShadowProfilesForCandidateIds>>[number]>,
) {
  const profile = profiles.get(candidate.id) ?? null;
  return {
    candidateId: candidate.id,
    discoveredAt: candidate.discoveredAt,
    updatedAt: candidate.updatedAt,
    provider: candidate.provider,
    discoveryQuery: candidate.discoveryQuery,
    searchResultTitle: candidate.titleHint,
    sourceUrl: candidate.sourceUrl,
    canonicalUrl: candidate.canonicalUrl,
    canonicalDomain: candidate.canonicalDomain,
    categoryHint: candidate.categoryHint,
    locationHint: candidate.locationHint,
    status: candidate.status,
    dedupDecision: candidate.dedupDecision ?? null,
    pagesVisited: pageMap.get(candidate.id) ?? [],
    profile: profile
      ? {
          businessName: profile.businessName,
          website: profile.website,
          location: profile.location,
          publicationQuality: profile.publicationQuality,
          coverImage: profile.coverImage,
          images: profile.images,
          imageCount: profile.images.length,
          mediaEvidence: profile.mediaEvidence,
        }
      : null,
  };
}

export async function getDiscoveryAudit(limit = 100) {
  const candidates = await listCandidates(Math.min(Math.max(limit, 1), 250));
  const ids = candidates.map(item => item.id);
  const [evidence, profiles] = await Promise.all([
    listEvidenceForCandidateIds(ids),
    getShadowProfilesForCandidateIds(ids),
  ]);
  const pageMap = pagesByCandidate(evidence);
  const profileMap = new Map(profiles.map(profile => [profile.candidateId, profile]));
  return {
    items: candidates.map(candidate => auditCandidate(candidate, pageMap, profileMap)),
  };
}
