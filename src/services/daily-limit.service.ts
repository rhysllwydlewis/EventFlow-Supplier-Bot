export function remainingDailyAllowance(
  campaignAcquiredToday: number,
  globalAcquiredToday: number,
  campaignHardLimit: number,
  globalHardLimit: number,
): number {
  const campaignAcquired = Math.max(0, Math.floor(campaignAcquiredToday));
  const globalAcquired = Math.max(0, Math.floor(globalAcquiredToday));
  const campaignLimit = Math.max(0, Math.floor(campaignHardLimit));
  const globalLimit = Math.max(0, Math.floor(globalHardLimit));

  const campaignRemaining = Math.max(0, campaignLimit - campaignAcquired);
  const globalRemaining = Math.max(0, globalLimit - globalAcquired);
  return Math.min(campaignRemaining, globalRemaining);
}
