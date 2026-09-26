import { describe, expect, it } from "vitest";
import { bestHour, gridToLocal, percentChange, toCsv, type ToLocal } from "./analytics";

const emptyGrid = () => Array.from({ length: 7 }, () => new Array<number>(24).fill(0));

/** A fixed UTC offset, independent of the machine running the tests. */
const offset =
  (hours: number): ToLocal =>
  (utc) => {
    const d = new Date(utc.getTime() + hours * 3_600_000);
    return { day: d.getUTCDay(), hour: d.getUTCHours() };
  };

describe("percentChange", () => {
  it("compares with the previous period, and gives up without a baseline", () => {
    expect(percentChange(150, 100)).toBe(0.5);
    expect(percentChange(50, 100)).toBe(-0.5);
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(null, 100)).toBeNull();
    expect(percentChange(10, null)).toBeNull();
  });
});

describe("gridToLocal", () => {
  it("shifts UTC hours into the local week, across midnight and the week's end", () => {
    const utc = emptyGrid();
    utc[0]![2] = 50; // Sunday 02:00 UTC
    utc[6]![22] = 70; // Saturday 22:00 UTC
    const california = gridToLocal(utc, offset(-7));
    expect(california[6]![19]).toBe(50); // Saturday 19:00
    expect(california[6]![15]).toBe(70); // Saturday 15:00
    const india = gridToLocal(utc, offset(5.5));
    // Half-hour zones land on the hour they fall in: 02:00 UTC is 07:30 IST.
    expect(india[0]![7]).toBe(50);
    expect(india[0]![3]).toBe(70); // Saturday 22:00 UTC → Sunday 03:30 IST
    expect(india[0]![4]).toBe(0);
  });
});

describe("bestHour", () => {
  it("finds the busiest hour for a day or the whole week", () => {
    const grid = emptyGrid();
    grid[1]![9] = 30;
    grid[2]![19] = 20;
    grid[3]![19] = 20;
    expect(bestHour(grid)).toBe(19);
    expect(bestHour(grid, 1)).toBe(9);
    expect(bestHour(grid, 4)).toBeNull();
  });
});

describe("toCsv", () => {
  it("quotes commas, quotes and line breaks, and defuses formulas", () => {
    expect(toCsv([["a", 1, null], ['He said "hi", then\nleft', "=HYPERLINK(1)", "-5"]])).toBe(
      'a,1,\r\n"He said ""hi"", then\nleft",\'=HYPERLINK(1),\'-5',
    );
    // Numbers are numbers, even negative ones.
    expect(toCsv([[-5]])).toBe("-5");
  });
});
