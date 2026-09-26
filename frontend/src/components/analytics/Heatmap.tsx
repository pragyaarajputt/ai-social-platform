"use client";

import { formatCount, hourLabel, WEEKDAYS_SUN_FIRST } from "@/lib/analytics";

// Monday first, as in the calendar.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Followers online by local weekday × hour. Darker = more followers online. */
export function Heatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(1, ...grid.flat());
  return (
    // relative: the sr-only labels are absolutely positioned; without it they escape the scroll box and widen the page.
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[36rem] table-fixed border-separate border-spacing-0.5 text-[10px]">
        <caption className="sr-only">Average followers online by day and hour, in your time zone</caption>
        <thead>
          <tr>
            <th scope="col" className="w-9" />
            {Array.from({ length: 24 }, (_, h) => (
              // Fixed layout keeps all 24 columns equal; every third label overflows its narrow column.
              <th key={h} scope="col" className="overflow-visible whitespace-nowrap text-left font-normal text-neutral-500">
                {h % 3 === 0 ? hourLabel(h) : <span className="sr-only">{hourLabel(h)}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ORDER.map((d) => (
            <tr key={d}>
              <th scope="row" className="pr-1 text-left font-normal text-neutral-500">
                {WEEKDAYS_SUN_FIRST[d]}
              </th>
              {grid[d]!.map((v, h) => (
                <td
                  key={h}
                  title={`${WEEKDAYS_SUN_FIRST[d]} ${hourLabel(h)}: about ${formatCount(v)} followers online`}
                  className="h-6 rounded-sm bg-violet-600"
                  style={{ opacity: v === 0 ? 0.06 : 0.12 + 0.88 * (v / max) }}
                >
                  <span className="sr-only">{v}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
