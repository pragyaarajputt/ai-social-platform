"use client";

import { useEffect, useMemo, useState } from "react";
import { bestHour, getBestTimes, gridToLocal, hourLabel } from "@/lib/analytics";

/** "Saturday" in the user's language (0 = Sunday). */
const weekdayName = (day: number) => new Date(Date.UTC(2026, 8, 20 + day)).toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" });

/**
 * "Your followers are most online around 7 PM on a Tuesday", for the account being scheduled to.
 * Shows nothing when there's no data (small accounts, analytics off, or an error).
 */
export function BestTimeHint({ workspaceId, accountId, day }: { workspaceId: string; accountId: string | undefined; day: number | null }) {
  const [loaded, setLoaded] = useState<{ accountId: string; grid: number[][] | null; username: string | null } | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let active = true;
    getBestTimes(workspaceId, accountId).then(
      (b) => active && setLoaded({ accountId, grid: b.grid, username: b.account?.username ?? null }),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [workspaceId, accountId]);

  const grid = useMemo(() => (loaded?.grid && loaded.accountId === accountId ? gridToLocal(loaded.grid) : null), [loaded, accountId]);
  if (!grid) return null;
  const hour = bestHour(grid, day ?? undefined);
  if (hour === null) return null;
  return (
    <p className="text-xs text-violet-700 dark:text-violet-300">
      @{loaded!.username}&apos;s followers are most online around {hourLabel(hour)}
      {day !== null ? ` on a ${weekdayName(day)}` : ""}.
    </p>
  );
}
