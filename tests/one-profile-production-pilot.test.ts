import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pilotSource = readFileSync('src/services/eventflow-one-profile-pilot.service.ts', 'utf8');
const stateSource = readFileSync('src/repositories/eventflow-pilot.repository.ts', 'utf8');
const ingestionSource = readFileSync('src/services/eventflow-ingestion.service.ts', 'utf8');
const normalPublicationSource = readFileSync('src/services/eventflow-publication.service.ts', 'utf8');
const entrySource = readFileSync('src/control/entry.ts', 'utf8');

describe('one-profile EventFlow production pilot', () => {
  it('is pinned to one known supplier and durable one-profile state', () => {
    expect(pilotSource).toContain("const PILOT_DOMAIN = 'hensolcastle.com'");
    expect(pilotSource).toContain('getCandidateByCanonicalDomain(PILOT_DOMAIN)');
    expect(stateSource).toContain("eventflow-one-profile-pilot-v1");
    expect(stateSource).toContain("collection<EventFlowPilotState>('eventflow_pilot_state')");
    expect(pilotSource).toContain("if (previous?.status === 'published') return previous");
  });

  it('re-runs the current crawl pipeline and preserves safety/compliance gates', () => {
    expect(pilotSource).toContain("isSuppressed(candidate.canonicalDomain, 'do_not_list')");
    expect(pilotSource).toContain("candidate.dedupDecision !== 'distinct'");
    expect(pilotSource).toContain("trigger: 'one-profile-production-pilot'");
    expect(pilotSource).toContain('profile.publicationQuality < MIN_PILOT_QUALITY');
    expect(pilotSource).toContain('profile.dataConfidence < MIN_PILOT_CONFIDENCE');
    expect(pilotSource).toContain('profile.evidenceIds.length === 0');
    expect(pilotSource).toContain('!compliance?.publicationEligible');
    expect(pilotSource).toContain("settings.runState === 'emergency_stopped'");
  });

  it('uses an explicit scoped ingestion bypass without enabling normal publication', () => {
    expect(pilotSource).toContain('publishingEnabled: true');
    expect(pilotSource).toContain('publicationScope: PILOT_PUBLICATION_SCOPE');
    expect(ingestionSource).toContain("publicationScope?: 'pilot_unclaimed'");
    expect(ingestionSource).toContain("...(input.publicationScope ? { publicationScope: input.publicationScope } : {})");
    expect(normalPublicationSource).toContain('!settings.publishingEnabled');
  });

  it('reconciles autonomously and exposes only sanitized pilot progress', () => {
    expect(entrySource).toContain('ONE_PROFILE_PILOT_RECONCILE_MS = 60_000');
    expect(entrySource).toContain('runOneProfileEventFlowPilot()');
    expect(entrySource).toContain('oneProfilePilot: {');
    expect(entrySource).toContain('publicProfileUrl: pilotPublicProfileUrl(pilot)');
    expect(entrySource).not.toContain('EVENTFLOW_BOT_HMAC_SECRET!');
  });
});
