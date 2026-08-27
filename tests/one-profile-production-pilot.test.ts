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
    expect(stateSource).toContain('eventflow-one-profile-pilot-v1');
    expect(stateSource).toContain("collection<EventFlowPilotState>('eventflow_pilot_state')");
    expect(stateSource).toContain('publicProfilePath: z.string().nullable().default(null)');
    expect(pilotSource).toContain(
      "if (previous?.status === 'published' && previous.publicProfilePath) return previous"
    );
  });

  it('re-runs the current crawl pipeline and recovers a stale refresh without fan-out', () => {
    expect(pilotSource).toContain("trigger: 'one-profile-production-pilot'");
    expect(pilotSource).toContain('PILOT_REFRESH_RETRY_AFTER_MS = 5 * 60_000');
    expect(pilotSource).toContain('refreshIsStale(previous)');
    expect(pilotSource).toContain("reason: 'current_pipeline_refresh_requeued'");
    expect(pilotSource).toContain('const retryBucket = Math.floor(Date.now() / PILOT_REFRESH_RETRY_AFTER_MS)');
  });

  it('preserves identity, quality and compliance gates', () => {
    expect(pilotSource).toContain("isSuppressed(candidate.canonicalDomain, 'do_not_list')");
    expect(pilotSource).toContain("candidate.dedupDecision !== 'distinct'");
    expect(pilotSource).toContain('profile.publicationQuality < MIN_PILOT_QUALITY');
    expect(pilotSource).toContain('profile.dataConfidence < MIN_PILOT_CONFIDENCE');
    expect(pilotSource).toContain('profile.evidenceIds.length === 0');
    expect(pilotSource).toContain('!compliance?.publicationEligible');
  });

  it('rechecks operator stop, identity and suppression immediately before the external write', () => {
    expect(pilotSource).toContain('const liveSettings = await getSettings()');
    expect(pilotSource).toContain('const liveRunBlockReason = pilotRunBlockReason(liveSettings)');
    expect(pilotSource).toContain("reason: 'identity_changed_before_send'");
    expect(pilotSource).toContain("isSuppressed(liveCandidate.canonicalDomain, 'do_not_list')");
    expect(pilotSource.indexOf('const liveSettings = await getSettings()')).toBeLessThan(
      pilotSource.indexOf('const result = await ingestShadowProfileToEventFlow')
    );
  });

  it('uses an explicit scoped ingestion bypass without enabling normal publication', () => {
    expect(pilotSource).toContain('publishingEnabled: liveSettings.publishingEnabled');
    expect(pilotSource).toContain('publicationScope: PILOT_PUBLICATION_SCOPE');
    expect(ingestionSource).toContain("PILOT_UNCLAIMED_SCOPE = 'pilot_unclaimed'");
    expect(ingestionSource).toContain('publicationScope?: EventFlowPublicationScope');
    expect(ingestionSource).toContain(
      '...(input.publicationScope ? { publicationScope: input.publicationScope } : {})'
    );
    expect(normalPublicationSource).toContain('!settings.publishingEnabled');
  });

  it('blocks the pilot on the same mode/publishing gate as normal publication', () => {
    expect(pilotSource).toContain("if (settings.mode !== 'live') return 'mode_not_live'");
    expect(pilotSource).toContain("if (!settings.publishingEnabled) return 'publishing_disabled'");
    expect(pilotSource).not.toContain("if (settings.mode === 'off') return 'bot_off'");
  });

  it('uses the exact EventFlow public profile path and repairs an already-published legacy pilot state', () => {
    expect(ingestionSource).toContain('publicProfilePath: z.string().regex');
    expect(ingestionSource).toContain('publicProfilePath: parsed.publicProfilePath ?? null');
    expect(pilotSource).toContain('if (!state?.publicProfilePath || state.status !== \'published\') return null');
    expect(pilotSource).toContain('new URL(state.publicProfilePath, EVENTFLOW_ORIGIN)');
    expect(pilotSource).toContain("reason: 'eventflow_public_profile_path_missing'");
    expect(pilotSource).toContain('publicProfilePath: result.publicProfilePath');
    expect(pilotSource).toContain('publishedAt: previous?.publishedAt ?? new Date().toISOString()');
    expect(pilotSource).not.toContain('function publicSlug');
  });

  it('reconciles autonomously and exposes only sanitized pilot progress', () => {
    expect(entrySource).toContain('ONE_PROFILE_PILOT_RECONCILE_MS = 60_000');
    expect(entrySource).toContain('runOneProfileEventFlowPilot()');
    expect(entrySource).toContain('oneProfilePilot: {');
    expect(entrySource).toContain('publicProfileUrl: pilotPublicProfileUrl(pilot)');
    expect(entrySource).not.toContain('EVENTFLOW_BOT_HMAC_SECRET!');
  });
});