import { useQuery } from "@tanstack/vue-query";
import type { MaybeRefOrGetter } from "vue";

import type { BackupStatus } from "~/utils/backup";

export const BACKUP_STATUS_KEY = ["health", "backup"] as const;

/**
 * Backup health from GET /api/health/backup. The backup container rewrites its
 * status at most hourly, so a 5-minute stale/poll window (the tag-facet value)
 * is plenty; someone else (the backup container) changes this state, hence the poll.
 */
export function useBackupStatus(enabled: MaybeRefOrGetter<boolean> = true) {
  const api = useApi();
  return useQuery(() => ({
    queryKey: BACKUP_STATUS_KEY,
    queryFn: () => api.get<BackupStatus>("/health/backup"),
    enabled: toValue(enabled),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  }));
}
