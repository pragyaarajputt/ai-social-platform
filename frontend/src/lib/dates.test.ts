import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addLocalDays, dayKey, formatRelative, fromDateTimeLocal, monthGrid, toDateTimeLocal } from "./dates";

// Run in a zone with daylight saving so the tricky days are covered.
// In Europe/London clocks go forward on 29 Mar 2026 and back on 25 Oct 2026.
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/London";
});
afterAll(() => {
  process.env.TZ = originalTz;
});

describe("datetime-local conversion", () => {
  it("round-trips local time", () => {
    const d = fromDateTimeLocal("2026-10-01T09:05")!;
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(5);
    expect(toDateTimeLocal(d)).toBe("2026-10-01T09:05");
    expect(d.toISOString()).toBe("2026-10-01T08:05:00.000Z"); // BST is UTC+1
  });

  it("rejects empty or malformed input", () => {
    expect(fromDateTimeLocal("")).toBeNull();
    expect(fromDateTimeLocal("tomorrow 9am")).toBeNull();
  });
});

describe("monthGrid()", () => {
  it("covers the month in Monday-first weeks", () => {
    const weeks = monthGrid(2026, 8); // September 2026 starts on a Tuesday
    expect(weeks[0]![0]!.getDay()).toBe(1); // Monday
    expect(dayKey(weeks[0]![0]!)).toBe("2026-08-31");
    expect(dayKey(weeks.at(-1)![6]!)).toBe("2026-10-04");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it("has every day exactly once across daylight-saving changes", () => {
    for (const month of [2, 9]) {
      // March and October 2026
      const keys = monthGrid(2026, month).flat().map(dayKey);
      expect(new Set(keys).size).toBe(keys.length);
      const inMonth = keys.filter((k) => k.startsWith(`2026-${String(month + 1).padStart(2, "0")}`));
      expect(inMonth).toHaveLength(31); // March and October both have 31 days
    }
  });

  it("adds calendar days, not 24-hour blocks", () => {
    expect(dayKey(addLocalDays(new Date(2026, 2, 28, 12), 1))).toBe("2026-03-29");
    expect(dayKey(addLocalDays(new Date(2026, 2, 29, 0, 30), 1))).toBe("2026-03-30");
  });
});

describe("formatRelative()", () => {
  const now = new Date("2026-09-25T10:00:00Z");
  it("describes how far away a time is", () => {
    expect(formatRelative(new Date("2026-09-25T10:30:00Z"), now)).toBe("in 30 min");
    expect(formatRelative(new Date("2026-09-26T03:20:00Z"), now)).toBe("in 17 h 20 min");
    expect(formatRelative(new Date("2026-09-30T10:00:00Z"), now)).toBe("in 5 days");
    expect(formatRelative(new Date("2026-09-25T09:55:00Z"), now)).toBe("5 min ago");
  });
});
