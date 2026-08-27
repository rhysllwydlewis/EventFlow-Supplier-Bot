import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Phase 3 stale provider failure recovery', () => {
  it('allows a recovery probe when the current worker started after the retained failure', () => {
    const entrySource = readFileSync(new URL('../src/control/entry.ts', import.meta.url), 'utf8');

    expect(entrySource).toContain("heartbeatIsFresh, listHeartbeats");
    expect(entrySource).toContain('workerRestartedAfterFailure');
    expect(entrySource).toContain("item.processType === 'worker'");
    expect(entrySource).toContain("item.status === 'ready'");
    expect(entrySource).toContain('heartbeatIsFresh(item)');
    expect(entrySource).toContain('(timestampMs(item.startedAt) ?? 0) > failureAt');
    expect(entrySource).toContain('!workerRestartedAfterFailure');
    expect(entrySource).toContain('allowing one recovery probe');
  });
});
