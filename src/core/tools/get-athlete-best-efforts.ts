// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { config_ } from "../../config.js";
import type { ToolDef, ToolContext } from "../../tool-registry.js";
import { intervalsClient } from "../intervals-client.js";
import { today } from "../../utils/date.js";
import {
  PERIOD_REGEX,
  effortRow,
  ladderIndex,
  periodToCurveId,
  snapToLadder,
} from "../../utils/pace-efforts.js";
import { fetchBulkEfforts } from "./get-best-efforts-bulk.js";

interface AthletePaceCurve {
  id: string;
  label?: string | null;
  start_date_local?: string | null;
  end_date_local?: string | null;
  distance?: number[] | null;
  values?: (number | null)[] | null;
  activity_id?: (string | null)[] | null;
}

export const getAthleteBestEffortsTool: ToolDef = {
  name: "get_athlete_best_efforts",
  title: "Get Athlete Best Efforts",
  description:
    "The athlete's ranked best efforts over one distance (default 5000 m) for a period — the " +
    "list on the Intervals.icu Best Efforts page. period: all, season (this season per the " +
    "athlete's Intervals.icu settings), <N>d (e.g. 42d), <N>y (e.g. 1y), or " +
    "YYYY-MM-DD..YYYY-MM-DD. The period's date range comes from Intervals.icu itself; <N>d/<N>y " +
    "windows END on `newest` (inclusive, default today) and start N days/years earlier — so " +
    "\"the 42 days before 5 Sep\" is period=42d, newest=<4 Sep>. Returns the period's best " +
    "(best: from the website's pace curve) and the top `count` activities ranked fastest first " +
    "(one row per activity: rank, activity_id, start_date_local, name, time, pace). A distance " +
    "not on the Intervals.icu ladder is rounded up to the next ladder distance (1609 → 1609.34).",
  schema: {
    distance_m: z
      .number()
      .positive()
      .max(1_000_000)
      .default(5000)
      .describe("Effort distance in meters (default 5000). Rounded up to the Intervals.icu ladder distance."),
    period: z
      .string()
      .regex(PERIOD_REGEX, "Use all, season, <N>d, <N>y, or YYYY-MM-DD..YYYY-MM-DD")
      .default("all")
      .describe('"all" (default), "season", "<N>d" (e.g. "42d"), "<N>y" (e.g. "1y"), or "YYYY-MM-DD..YYYY-MM-DD".'),
    newest: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
      .optional()
      .describe("Last day (inclusive) of the <N>d / <N>y / season window, YYYY-MM-DD. Default: today."),
    type: z
      .string()
      .default("Run")
      .describe('Activity type, e.g. "Run", "TrailRun", "VirtualRun" (default "Run"). Case-sensitive.'),
    count: z.number().int().positive().max(500).default(50).describe("Number of ranked rows (default 50)."),
    gap: z.boolean().default(false).describe("true = grade-adjusted pace (GAP) best efforts."),
  },
  handler: async (
    { distance_m, period, newest, type, count, gap }: {
      distance_m: number;
      period: string;
      newest?: string;
      type: string;
      count: number;
      gap: boolean;
    },
    ctx?: ToolContext,
  ) => {
    const curveId = periodToCurveId(period);
    const asOf = newest ?? today(config_.timezone);
    const resp = (await intervalsClient.getAthletePaceCurves([curveId], asOf, type, gap, {
      signal: ctx?.signal,
    })) as { list?: AthletePaceCurve[] };
    const curve = resp?.list?.find((c) => c.id === curveId) ?? resp?.list?.[0];
    if (!curve?.start_date_local || !curve.end_date_local) {
      throw new Error(`Intervals.icu returned no pace curve for period "${period}" (curve id "${curveId}").`);
    }
    const start = curve.start_date_local.slice(0, 10);
    const end = curve.end_date_local.slice(0, 10);

    // The period's single best, straight from the website's curve.
    const ladder = curve.distance ?? [];
    const snapped = snapToLadder(distance_m, ladder);
    const i = snapped === null ? -1 : ladderIndex(snapped, ladder);
    const bestTime = i >= 0 ? curve.values?.[i] : undefined;
    const best = snapped !== null && typeof bestTime === "number"
      ? { ...effortRow(snapped, bestTime), activity_id: curve.activity_id?.[i] ?? null }
      : null;

    const { distance_m: used, rows } = await fetchBulkEfforts(start, end, distance_m, type, gap, ctx?.signal);
    const ranked = rows.slice(0, count).map((r, idx) => ({ rank: idx + 1, ...r }));

    const usedDistance = snapped ?? used;
    const warnings: string[] = [];
    if (best && ranked[0] && (ranked[0].time_s !== best.time_s || ranked[0].activity_id !== best.activity_id)) {
      warnings.push(
        `Ranked #1 (${ranked[0].activity_id}, ${ranked[0].time}) differs from the period best on the ` +
        `pace curve (${best.activity_id}, ${best.time}); the curve value is what the website shows.`,
      );
    }

    return {
      period,
      label: curve.label ?? null,
      start,
      end,
      type,
      gap,
      distance_m: usedDistance === null ? distance_m : Math.round(usedDistance * 100) / 100,
      ...(usedDistance !== null && Math.abs(usedDistance - distance_m) > 0.01 ? { requested_m: distance_m } : {}),
      best,
      activities_with_distance: rows.length,
      ranked,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
