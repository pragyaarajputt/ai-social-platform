// Date helpers for scheduling. Everything is stored in UTC and shown in the browser's own time zone.
// Days and months are built from local calendar fields (never by adding 24 h), so daylight-saving
// changes can't skip or repeat a day.

import { useEffect, useState } from "react";

/**
 * The current time, refreshed every `intervalMs`. Components use this instead of calling Date.now()
 * while rendering (which React requires to be pure), and it keeps "in 5 min" labels up to date.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The browser's IANA time zone, e.g. "Asia/Kolkata". */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Value for <input type="datetime-local"> in local time, e.g. "2026-10-01T09:00". */
export function toDateTimeLocal(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parses a datetime-local value as local time. Returns null for empty or invalid input. */
export function fromDateTimeLocal(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Thu 1 Oct, 9:00 AM". */
export function formatDateTime(date: Date): string {
  return date.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "in 17 h 20 min", "in 3 days", "5 min ago". */
export function formatRelative(date: Date, now = new Date()): string {
  const diffMin = Math.round((date.getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(diffMin);
  const text =
    abs < 1
      ? "less than a minute"
      : abs < 60
        ? `${abs} min`
        : abs < 48 * 60
          ? `${Math.floor(abs / 60)} h${abs % 60 ? ` ${abs % 60} min` : ""}`
          : `${Math.round(abs / (24 * 60))} days`;
  return diffMin >= 0 ? `in ${text}` : `${text} ago`;
}

/** Local calendar day key, e.g. "2026-10-01". */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * The weeks shown for a month: full Monday-to-Sunday weeks covering the whole month, including
 * trailing days of the previous month and leading days of the next.
 */
export function monthGrid(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // days since Monday
  const start = new Date(year, month, 1 - offset);
  const last = new Date(year, month + 1, 0);
  const weeks: Date[][] = [];
  for (let w = 0; ; w++) {
    const week = Array.from({ length: 7 }, (_, d) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d));
    weeks.push(week);
    if (week[6]! >= last) break;
  }
  return weeks;
}

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
