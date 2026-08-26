import { describe, expect, it } from 'vitest';
import { crawlJobId, legacyCrawlJobId } from '../src/services/crawl-queue.service.js';

describe('crawl queue job identity', () => {
  it('is idempotent within a UTC day and changes on the next day', () => {
    expect(crawlJobId('candidate_1', '2026-08-26')).toBe('crawl-candidate_1-2026-08-26');
    expect(crawlJobId('candidate_1', '2026-08-26')).toBe(crawlJobId('candidate_1', '2026-08-26'));
    expect(crawlJobId('candidate_1', '2026-08-27')).not.toBe(crawlJobId('candidate_1', '2026-08-26'));
  });

  it('recognises the pre-date rollout job identity', () => {
    expect(legacyCrawlJobId('candidate_1')).toBe('crawl-candidate_1');
  });
});
