// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  bestEffortsFromCurve,
  formatDuration,
  formatPace,
  mapWithConcurrency,
  paceSecondsPerKm,
  periodToCurveId,
  rankBulkEfforts,
  snapToLadder,
  yearChunks,
  type ActivityMeta,
} from "../src/utils/pace-efforts.js";

/** A slice of the real Intervals.icu ladder (note the float noise on 45.719997). */
const LADDER = [45.719997, 100, 400, 402.335, 800, 1000, 1280.16, 1500, 1609.34, 3000, 5000, 10000, 21097.5, 42195];

describe("snapToLadder (round up, as the website does)", () => {
  it("keeps exact ladder distances", () => {
    expect(snapToLadder(400, LADDER)).toBe(400);
    expect(snapToLadder(5000, LADDER)).toBe(5000);
  });
  it("rounds up to the next ladder distance", () => {
    expect(snapToLadder(1609, LADDER)).toBe(1609.34);
    expect(snapToLadder(1234, LADDER)).toBe(1280.16);
    expect(snapToLadder(21097, LADDER)).toBe(21097.5);
    expect(snapToLadder(401, LADDER)).toBe(402.335);
  });
  it("tolerates float noise and returns null past the end", () => {
    expect(snapToLadder(45.72, LADDER)).toBe(45.719997);
    expect(snapToLadder(50000, LADDER)).toBeNull();
  });
});

describe("formatting", () => {
  it("formats durations like the website", () => {
    expect(formatDuration(119)).toBe("1:59");
    expect(formatDuration(1653)).toBe("27:33");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
  it("computes and formats pace per km", () => {
    expect(paceSecondsPerKm(5000, 1653)).toBe(330.6);
    expect(formatPace(330.6)).toBe("5:31/km");
    expect(paceSecondsPerKm(1609.34, 517)).toBe(321.2);
  });
});

describe("bestEffortsFromCurve", () => {
  // Shaped like a 5.09 km run: the curve stops at 5000 m.
  const curve = {
    distance: [400, 800, 1000, 1500, 1609.34, 3000, 5000],
    values: [119, 249, 314, 480, 517, 966, 1653],
  };

  it("reads the requested distances straight off the curve", () => {
    const { efforts, omitted } = bestEffortsFromCurve(curve, [400, 800, 1000, 1500, 1609, 3000, 5000, 10000, 21097, 42195]);
    expect(efforts.map((e) => [e.distance_m, e.time])).toEqual([
      [400, "1:59"], [800, "4:09"], [1000, "5:14"], [1500, "8:00"],
      [1609.34, "8:37"], [3000, "16:06"], [5000, "27:33"],
    ]);
    expect(efforts.find((e) => e.distance_m === 5000)).toMatchObject({ time_s: 1653, pace: "5:31/km" });
    expect(omitted).toEqual([10000, 21097, 42195]);
  });

  it("flags rounded-up distances with requested_m and not exact ones", () => {
    const { efforts } = bestEffortsFromCurve(curve, [1609, 5000]);
    expect(efforts[0]).toMatchObject({ distance_m: 1609.34, requested_m: 1609 });
    expect(efforts[1]).not.toHaveProperty("requested_m");
  });

  it("merges requests that round up to the same ladder distance", () => {
    const { efforts, omitted } = bestEffortsFromCurve(curve, [1600, 1609]);
    expect(efforts).toHaveLength(1);
    expect(efforts[0]).toMatchObject({ distance_m: 1609.34, requested_m: 1600 });
    expect(omitted).toEqual([]);
  });

  it("omits distances whose value is null and handles an empty curve", () => {
    expect(bestEffortsFromCurve({ distance: [400, 800], values: [100, null] }, [400, 800]))
      .toEqual({ efforts: [expect.objectContaining({ distance_m: 400 })], omitted: [800] });
    expect(bestEffortsFromCurve({}, [400])).toEqual({ efforts: [], omitted: [400] });
  });
});

describe("rankBulkEfforts", () => {
  const meta = new Map<string, ActivityMeta>([
    ["i1", { name: "Parkrun A", distance: 5093.4 }],
    ["i2", { name: "Parkrun B", distance: 5102 }],
  ]);

  it("ranks fastest first across chunks, joins names, drops short runs", () => {
    const rows = rankBulkEfforts([
      { distances: [5000], curves: [
        { id: "i1", start_date_local: "2026-09-05T09:09:59", secs: [1653] },
        { id: "i3", start_date_local: "2026-09-04T08:00:00", secs: [] },
      ] },
      { distances: [5000], curves: [{ id: "i2", start_date_local: "2025-10-25T09:05:27", secs: [1642] }] },
    ], meta);
    expect(rows.map((r) => [r.activity_id, r.time, r.name])).toEqual([
      ["i2", "27:22", "Parkrun B"],
      ["i1", "27:33", "Parkrun A"],
    ]);
    expect(rows[0]).toMatchObject({ distance_m: 5000, activity_distance_m: 5102, pace: "5:28/km" });
  });

  it("breaks ties by date (earlier first) and dedupes activities", () => {
    const rows = rankBulkEfforts([
      { distances: [5000], curves: [
        { id: "i9", start_date_local: "2026-01-02T00:00:00", secs: [1700] },
        { id: "i8", start_date_local: "2026-01-01T00:00:00", secs: [1700] },
      ] },
      { distances: [5000], curves: [{ id: "i9", start_date_local: "2026-01-02T00:00:00", secs: [1700] }] },
    ], new Map());
    expect(rows.map((r) => r.activity_id)).toEqual(["i8", "i9"]);
    expect(rows[0].name).toBeNull();
  });
});

describe("yearChunks", () => {
  it("splits an inclusive range at calendar years", () => {
    expect(yearChunks("2024-06-10", "2026-02-01")).toEqual([
      ["2024-06-10", "2024-12-31"], ["2025-01-01", "2025-12-31"], ["2026-01-01", "2026-02-01"],
    ]);
  });
  it("keeps a single-year range as one chunk and rejects inverted ranges", () => {
    expect(yearChunks("2026-09-05", "2026-09-05")).toEqual([["2026-09-05", "2026-09-05"]]);
    expect(yearChunks("2026-09-06", "2026-09-05")).toEqual([]);
  });
});

describe("periodToCurveId", () => {
  it("maps user periods to Intervals.icu curve ids", () => {
    expect(periodToCurveId("all")).toBe("all");
    expect(periodToCurveId("season")).toBe("s0");
    expect(periodToCurveId("42d")).toBe("42d");
    expect(periodToCurveId("1y")).toBe("1y");
    expect(periodToCurveId("2025-01-01..2025-12-31")).toBe("r.2025-01-01.2025-12-31");
  });
  it("rejects unsupported or inverted periods", () => {
    expect(() => periodToCurveId("s1")).toThrow(/Unsupported period/);
    expect(() => periodToCurveId("last week")).toThrow(/Unsupported period/);
    expect(() => periodToCurveId("2026-01-01..2025-01-01")).toThrow(/start is after end/);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order and bounds concurrency", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 3, 2, 4], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });
});
