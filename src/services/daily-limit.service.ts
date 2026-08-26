export function remainingDailyAllowance(
  acquiredToday: number,
  campaignHardLimit: number,
  globalHardLimit: number,
): number {
  const acquired = Math.max(0, Math.floor(acquiredToday));
  const campaignLimit = Math.max(0, Math.floor(campaignHardLimit));
  const globalLimit = Math.max(0, Math.floor(globalHardLimit));
  const effectiveLimit = Math.min(campaignLimit, globalLimit);
  return Math.max(0, effectiveLimit - acquired);
}
