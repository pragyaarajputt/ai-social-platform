"use client";

import { useId, useState } from "react";
import { formatCount } from "@/lib/analytics";

export interface Series {
  label: string;
  /** Tailwind stroke/fill color classes, e.g. "stroke-violet-600 fill-violet-600". */
  colorClass: string;
  values: (number | null)[];
}

const W = 640;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 44 };

/** A rounded "nice" axis maximum: 1, 2 or 5 × a power of ten. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 5, 10].find((m) => m * power >= max) ?? 10) * power;
}

/**
 * A small responsive line chart. Missing days (null) break the line instead of dropping to zero.
 * Screen readers get the same numbers as a table.
 */
export function LineChart({ labels, series, title }: { labels: string[]; series: Series[]; title: string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v != null))));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (labels.length <= 1 ? innerW / 2 : (i / (labels.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

  const path = (values: (number | null)[]) => {
    let d = "";
    let drawing = false;
    values.forEach((v, i) => {
      if (v == null) {
        drawing = false;
        return;
      }
      d += `${drawing ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      drawing = true;
    });
    return d.trim();
  };

  const tickEvery = Math.max(1, Math.ceil(labels.length / 7));
  const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <figure>
      <div className="flex flex-wrap gap-4 text-xs text-neutral-600 dark:text-neutral-400" aria-hidden>
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <svg width="12" height="4" className={s.colorClass}>
              <rect width="12" height="4" rx="2" />
            </svg>
            {s.label}
          </span>
        ))}
        {hover !== null ? (
          <span className="ml-auto font-medium text-neutral-800 dark:text-neutral-200">
            {shortDate(labels[hover]!)}: {series.map((s) => `${s.label} ${formatCount(s.values[hover])}`).join(" · ")}
          </span>
        ) : null}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 w-full touch-none"
        role="img"
        aria-labelledby={`${id}-title`}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          const i = Math.round(((px - PAD.left) / innerW) * (labels.length - 1));
          setHover(i >= 0 && i < labels.length ? i : null);
        }}
      >
        <title id={`${id}-title`}>{title}</title>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(max * f)} y2={y(max * f)} className="stroke-neutral-200 dark:stroke-neutral-800" />
            <text x={PAD.left - 6} y={y(max * f) + 4} textAnchor="end" className="fill-neutral-500 text-[11px]">
              {formatCount(max * f)}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % tickEvery === 0 ? (
            <text key={l} x={x(i)} y={H - 8} textAnchor="middle" className="fill-neutral-500 text-[11px]">
              {shortDate(l)}
            </text>
          ) : null,
        )}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} className="stroke-neutral-300 dark:stroke-neutral-700" /> : null}
        {series.map((s) => (
          <g key={s.label} className={s.colorClass}>
            <path d={path(s.values)} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="fill-none" />
            {/* Dots for days whose neighbours are missing, so a lone day is still visible. */}
            {s.values.map((v, i) =>
              v != null && (hover === i || (s.values[i - 1] == null && s.values[i + 1] == null)) ? (
                <circle key={i} cx={x(i)} cy={y(v)} r={3} className="stroke-none" />
              ) : null,
            )}
          </g>
        ))}
      </svg>
      {/* sr-only on a wrapper: a <table> ignores the 1px width and can widen the page. */}
      <div className="sr-only">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th>Date</th>
              {series.map((s) => (
                <th key={s.label}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={l}>
                <td>{l}</td>
                {series.map((s) => (
                  <td key={s.label}>{s.values[i] ?? "no data"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
