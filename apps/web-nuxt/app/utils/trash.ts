const DEFAULT_PURGE_DAYS = 30;

export function daysLeft(deletedAt: string | null, now: Date = new Date()): number | null {
  if (!deletedAt) return null;
  const deleted = new Date(deletedAt);
  if (Number.isNaN(deleted.getTime())) return null;
  const elapsedDays = (now.getTime() - deleted.getTime()) / 86_400_000;
  return Math.max(0, Math.ceil(DEFAULT_PURGE_DAYS - elapsedDays));
}
