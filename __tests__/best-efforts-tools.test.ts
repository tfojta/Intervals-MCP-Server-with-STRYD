// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { intervalsClient } from "../src/core/intervals-client.js";
import { getActivityBestEffortsTool } from "../src/core/tools/get-activity-best-efforts.js";
import { getBestEffortsBulkTool } from "../src/core/tools/get-best-efforts-bulk.js";
import { getAthleteBestEffortsTool } from "../src/core/tools/get-athlete-best-efforts.js";
import type { ToolDef } from "../src/tool-registry.js";

type Call = { path: string; method: string; params: URLSearchParams };
type RouteResult = { status?: number; body?: unknown; headers?: Record<string, string> };

/** Stub fetch with a router on (method, path, query) and record every call. */
function routedFetch(router: (c: Call) => RouteResult): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const call: Call = { path: u.pathname, method: init?.method ?? "GET", params: u.searchParams };
      calls.push(call);
      const res = router(call);
      return Promise.resolve(
        new Response(res.body === undefined ? "" : JSON.stringify(res.body), {
          status: res.status ?? 200,
          headers: res.headers,
        }),
      );
    }),
  );
  return { calls };
}

/** Run a tool the way the adapters do: schema defaults/validation, then the handler. */
async function run(tool: ToolDef, args: Record<string, unknown>): Promise<any> {
  const parsed = await z.object(tool.schema).parseAsync(args);
  return tool.handler(parsed);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ATHLETE = "/api/v1/athlete/i12345678";

describe("get_activity_best_efforts", () => {
  it("returns compact rows from the activity pace curve (GET only)", async () => {
    const { calls } = routedFetch((c) => {
      expect(c.path).toBe("/api/v1/activity/i100/pace-curve.json");
      return {
        body: {
          id: "i100",
          type: "PACE",
          distance: [400, 800, 1000, 1500, 1609.34, 3000, 5000],
          values: [119, 249, 314, 480, 517, 966, 1653],
          start_index: [0, 0, 0, 0, 0, 0, 0],
        },
      };
    });
    const out = await run(getActivityBestEffortsTool, { activity_id: "i100" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls[0].params.get("gap")).toBe("false");
    expect(out.efforts.map((e: any) => e.time)).toEqual(["1:59", "4:09", "5:14", "8:00", "8:37", "16:06", "27:33"]);
    expect(out.efforts.at(-1)).toMatchObject({ distance_m: 5000, time_s: 1653, pace_s_per_km: 330.6 });
    expect(out.omitted_m).toEqual([10000, 21097, 42195]);
    expect(out).not.toHaveProperty("start_index");
  });

  it("passes gap and returns the whole curve with raw=true", async () => {
    const curve = { id: "i100", distance: [400], values: [120] };
    const { calls } = routedFetch(() => ({ body: curve }));
    const out = await run(getActivityBestEffortsTool, { activity_id: "i100", gap: true, raw: true });
    expect(calls[0].params.get("gap")).toBe("true");
    expect(out).toEqual(curve);
  });

  it("rejects an activity name in place of an id", async () => {
    await expect(run(getActivityBestEffortsTool, { activity_id: "Morning Run" })).rejects.toThrow();
  });
});

describe("get_best_efforts_bulk", () => {
  it("chunks by year, joins names, ranks fastest first, applies limit", async () => {
    const { calls } = routedFetch((c) => {
      const from = c.params.get("oldest")!;
      if (c.path === `${ATHLETE}/activity-pace-curves.json`) {
        expect(c.params.get("distances")).toBe("5000");
        expect(c.params.get("type")).toBe("Run");
        const curves = from.startsWith("2025")
          ? [{ id: "i2", start_date_local: "2025-10-25T09:05:27", secs: [1642] }]
          : from.startsWith("2026")
            ? [
                { id: "i1", start_date_local: "2026-09-05T09:09:59", secs: [1653] },
                { id: "i3", start_date_local: "2026-09-02T11:48:22", secs: [1727] },
                { id: "i4", start_date_local: "2026-09-01T07:00:00", secs: [] },
              ]
            : [];
        return { body: { distances: [5000], gap: false, curves } };
      }
      if (c.path === `${ATHLETE}/activities`) {
        expect(c.params.get("fields")).toBe("id,name,distance,type");
        return {
          body: from.startsWith("2025")
            ? [{ id: "i2", name: "Parkrun B", distance: 5102 }]
            : [{ id: "i1", name: "Parkrun A", distance: 5093 }, { id: "i3", name: "Tempo", distance: 8000 }],
        };
      }
      throw new Error(`unexpected ${c.path}`);
    });

    const out = await run(getBestEffortsBulkTool, { oldest: "2024-11-01", newest: "2026-09-26", limit: 2 });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    const chunks = calls.filter((c) => c.path.endsWith("activity-pace-curves.json"))
      .map((c) => `${c.params.get("oldest")}..${c.params.get("newest")}`).sort();
    expect(chunks).toEqual(["2024-11-01..2024-12-31", "2025-01-01..2025-12-31", "2026-01-01..2026-09-26"]);
    // The empty 2024 chunk needs no name lookup.
    expect(calls.filter((c) => c.path.endsWith("/activities"))).toHaveLength(2);
    expect(out).toMatchObject({ distance_m: 5000, activities_with_distance: 3, returned: 2 });
    expect(out.efforts.map((e: any) => [e.activity_id, e.time, e.name])).toEqual([
      ["i2", "27:22", "Parkrun B"],
      ["i1", "27:33", "Parkrun A"],
    ]);
  });

  it("reports the ladder distance used when rounding up", async () => {
    routedFetch((c) =>
      c.path.endsWith("activity-pace-curves.json")
        ? { body: { distances: [1609.34], curves: [{ id: "i1", start_date_local: "2026-09-05T09:09:59", secs: [517] }] } }
        : { body: [{ id: "i1", name: "Parkrun A", distance: 5093 }] },
    );
    const out = await run(getBestEffortsBulkTool, { oldest: "2026-09-01", newest: "2026-09-30", distance_m: 1609 });
    expect(out).toMatchObject({ distance_m: 1609.34, requested_m: 1609 });
    expect(out.efforts[0]).toMatchObject({ time: "8:37", distance_m: 1609.34 });
  });

  it("rejects oldest after newest without calling the API", async () => {
    const { calls } = routedFetch(() => ({ body: {} }));
    await expect(run(getBestEffortsBulkTool, { oldest: "2026-09-27", newest: "2026-09-26" })).rejects.toThrow(/after/);
    expect(calls).toHaveLength(0);
  });
});

describe("get_athlete_best_efforts", () => {
  function athleteRouter(curveBest: { time: number; id: string }) {
    return (c: Call): RouteResult => {
      if (c.path === `${ATHLETE}/pace-curves.json`) {
        return {
          body: {
            list: [{
              id: c.params.get("curves"),
              label: "42 days",
              start_date_local: "2026-08-15T00:00:00",
              end_date_local: `${c.params.get("newest")}T23:59:59`,
              distance: [400, 1000, 5000],
              values: [110, 300, curveBest.time],
              activity_id: ["i9", "i9", curveBest.id],
            }],
            activities: {},
          },
        };
      }
      if (c.path.endsWith("activity-pace-curves.json")) {
        return {
          body: {
            distances: [5000],
            curves: [
              { id: "i190", start_date_local: "2026-09-26T09:04:38", secs: [1665] },
              { id: "i183", start_date_local: "2026-09-05T09:09:59", secs: [1653] },
            ],
          },
        };
      }
      return { body: [{ id: "i183", name: "Parkrun #8", distance: 5093 }, { id: "i190", name: "Parkrun #10", distance: 5090 }] };
    };
  }

  it("resolves the period window from Intervals.icu and ranks within it", async () => {
    const { calls } = routedFetch(athleteRouter({ time: 1653, id: "i183" }));
    const out = await run(getAthleteBestEffortsTool, { period: "42d", newest: "2026-09-26" });
    const pc = calls.find((c) => c.path.endsWith("/pace-curves.json"))!;
    expect(pc.params.get("curves")).toBe("42d");
    expect(pc.params.get("newest")).toBe("2026-09-26");
    const bulk = calls.find((c) => c.path.endsWith("activity-pace-curves.json"))!;
    expect(`${bulk.params.get("oldest")}..${bulk.params.get("newest")}`).toBe("2026-08-15..2026-09-26");
    expect(out).toMatchObject({ start: "2026-08-15", end: "2026-09-26", distance_m: 5000, label: "42 days" });
    expect(out.best).toMatchObject({ time: "27:33", activity_id: "i183" });
    expect(out.ranked.map((r: any) => [r.rank, r.activity_id, r.time])).toEqual([
      [1, "i183", "27:33"],
      [2, "i190", "27:45"],
    ]);
    expect(out).not.toHaveProperty("warnings");
  });

  it("maps season to s0 and warns if the ranking disagrees with the curve", async () => {
    const { calls } = routedFetch(athleteRouter({ time: 1600, id: "i999" }));
    const out = await run(getAthleteBestEffortsTool, { period: "season", newest: "2026-09-26" });
    expect(calls.find((c) => c.path.endsWith("/pace-curves.json"))!.params.get("curves")).toBe("s0");
    expect(out.warnings?.[0]).toMatch(/differs from the period best/);
  });

  it("errors clearly when the API drops an unknown curve", async () => {
    routedFetch(() => ({ body: { list: [], activities: {} } }));
    await expect(run(getAthleteBestEffortsTool, { period: "3y", newest: "2026-09-26" }))
      .rejects.toThrow(/no pace curve for period "3y"/);
  });

  it("rejects an unsupported period at validation", async () => {
    await expect(run(getAthleteBestEffortsTool, { period: "s1" })).rejects.toThrow();
  });
});

describe("rate limiting (HTTP 429)", () => {
  it("backs off and retries, honouring Retry-After", async () => {
    vi.useFakeTimers();
    let n = 0;
    const { calls } = routedFetch(() => {
      n++;
      if (n === 1) return { status: 429, body: "slow down", headers: { "Retry-After": "2" } };
      if (n === 2) return { status: 429, body: "slow down" };
      return { body: { id: "i100", distance: [400], values: [120] } };
    });
    const pending = intervalsClient.getActivityPaceCurve("i100", false);
    await vi.advanceTimersByTimeAsync(2000); // Retry-After: 2
    await vi.advanceTimersByTimeAsync(10_000); // second attempt: exponential fallback (10 s)
    await expect(pending).resolves.toMatchObject({ values: [120] });
    expect(calls).toHaveLength(3);
  });

  it("gives up after 3 retries", async () => {
    vi.useFakeTimers();
    const { calls } = routedFetch(() => ({ status: 429, body: "slow down", headers: { "Retry-After": "1" } }));
    const pending = intervalsClient.getActivityPaceCurve("i100", false);
    const assertion = expect(pending).rejects.toThrow(/429/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(calls).toHaveLength(4);
  });
});
