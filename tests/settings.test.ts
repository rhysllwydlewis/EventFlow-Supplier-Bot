import { describe, expect, it } from 'vitest';
import { defaultSettings, botSettingsSchema } from '../src/domain/settings.js';
import { southWalesVenuePilot } from '../src/domain/campaign.js';

 describe('safe defaults', () => {
  it('starts stopped in shadow mode with publishing disabled', () => {
    const settings = botSettingsSchema.parse(defaultSettings());
    expect(settings.mode).toBe('shadow');
    expect(settings.runState).toBe('stopped');
    expect(settings.dailyTarget).toBe(10);
    expect(settings.dailyHardLimit).toBe(10);
    expect(settings.publishingEnabled).toBe(false);
    expect(settings.marketingEnabled).toBe(false);
    expect(settings.seoIndexingEnabled).toBe(false);
  });

  it('ships the agreed South Wales venue pilot as a draft', () => {
    const campaign = southWalesVenuePilot();
    expect(campaign.categories).toEqual(['Venues']);
    expect(campaign.locations).toEqual(['South Wales']);
    expect(campaign.dailyTarget).toBe(10);
    expect(campaign.dailyHardLimit).toBe(10);
    expect(campaign.status).toBe('draft');
  });
});
