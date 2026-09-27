// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { ToolDef, ToolContext } from "../../tool-registry.js";
import { intervalsClient } from "../intervals-client.js";
import {
  mapWithConcurrency,
  rankBulkEfforts,
  yearChunks,
  type ActivityMeta,
  type ActivityPaceCurvesPayload,
  type BulkEffortRow,
} from "../../utils/pace-efforts.js";

/** Year chunks fetched in parallel (each chunk = 1–2 GETs). */
const CHUNK_CONCURRENCY = 3;

export interface BulkEffortsResult {
  /** Ladder distance actually used (the request rounded up), or null if nothing came back. */
  distance_m: number | null;
  rows: BulkEffortRow[];
}

/**
 * Fetch one distance's best effort for every activity in [oldest, newest] and rank
 * them fastest first. The range is split into calendar-year chunks (each an
 * activity-pace-curves call, plus a fields-projected activity list for names when
 * the chunk has efforts), so a full multi-year history stays a set of small
 * responses. Shared by get_best_efforts_bulk and get_athlete_best_efforts.
 */
export async function fetchBulkEfforts(
  oldest: string,
  newest: string,
  distanceM: number,
  type: string,
  gap: boolean,
  signal?: AbortSignal,
): Promise<BulkEffortsResult> {
  const chunks = yearChunks(oldest, newest);
  const results = await mapWithConcurrency(chunks, CHUNK_CONCURRENCY, async ([from, to]) => {
    const payload = (await intervalsClient.getActivityPaceCurves(
      from, to, type, [distanceM], gap, { signal },
    )) as ActivityPaceCurvesPayload;
    const hasEfforts = (payload?.curves ?? []).some((c) => typeof c.secs?.[0] === "number");
    const list = hasEfforts
      ? await intervalsClient.getActivityList(from, to, ["id", "name", "distance", "type"], { signal })
      : [];
    return { payload, list: list as Array<{ id: string } & ActivityMeta> };
  });

  const meta = new Map<string, ActivityMeta>();
  for (const { list } of results) for (const a of list) meta.set(a.id, a);
  const payloads = results.map((r) => r.payload).filter(Boolean);
  return {
    distance_m: payloads.find((p) => p.distances?.length)?.distances?.[0] ?? null,
    rows: rankBulkEfforts(payloads, meta),
  };
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

export const getBestEffortsBulkTool: ToolDef = {
  name: "get_best_efforts_bulk",
  title: "Get Best Efforts (Bulk)",
  description:
    "Best time over ONE distance (default 5000 m) for EVERY activity in a date range, sorted " +
    "fastest first — e.g. every 5 km effort since 2017 in one call (fetched internally in " +
    "year-sized chunks). Each row: activity_id, start_date_local, name, activity_distance_m " +
    "(whole run), distance_m (effort), time_s, time, pace_s_per_km, pace. Times are the " +
    "Intervals.icu pace-curve values (same as the website); a distance not on the Intervals.icu " +
    "ladder is rounded up to the next ladder distance (1609 → 1609.34). Activities shorter than " +
    "the distance are left out. Set limit for a top-N list (recommended for long ranges — every " +
    "row costs tokens). For the athlete's ranked list over a named period (season, 42d, all time) " +
    "use get_athlete_best_efforts.",
  schema: {
    oldest: dateSchema.describe("Start date (inclusive), YYYY-MM-DD"),
    newest: dateSchema.describe("End date (inclusive), YYYY-MM-DD"),
    distance_m: z
      .number()
      .positive()
      .max(1_000_000)
      .default(5000)
      .describe("Effort distance in meters (default 5000). Rounded up to the Intervals.icu ladder distance."),
    type: z
      .string()
      .default("Run")
      .describe('Activity type, e.g. "Run", "TrailRun", "VirtualRun" (default "Run"). Case-sensitive.'),
    gap: z.boolean().default(false).describe("true = grade-adjusted pace (GAP) best efforts."),
    limit: z
      .number()
      .int()
      .positive()
      .max(5000)
      .nullable()
      .default(null)
      .describe("Return only the fastest N rows (default: all)."),
  },
  handler: async (
    { oldest, newest, distance_m, type, gap, limit }: {
      oldest: string;
      newest: string;
      distance_m: number;
      type: string;
      gap: boolean;
      limit: number | null;
    },
    ctx?: ToolContext,
  ) => {
    if (oldest > newest) throw new Error(`oldest (${oldest}) is after newest (${newest}).`);
    const { distance_m: used, rows } = await fetchBulkEfforts(oldest, newest, distance_m, type, gap, ctx?.signal);
    const efforts = limit === null ? rows : rows.slice(0, limit);
    return {
      oldest,
      newest,
      type,
      gap,
      distance_m: used === null ? distance_m : Math.round(used * 100) / 100,
      ...(used !== null && Math.abs(used - distance_m) > 0.01 ? { requested_m: distance_m } : {}),
      activities_with_distance: rows.length,
      returned: efforts.length,
      efforts,
    };
  },
};
