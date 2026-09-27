// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { ToolDef, ToolContext } from "../../tool-registry.js";
import { intervalsClient } from "../intervals-client.js";
import {
  DEFAULT_BEST_EFFORT_DISTANCES_M,
  bestEffortsFromCurve,
  type PaceCurveLike,
} from "../../utils/pace-efforts.js";

export const getActivityBestEffortsTool: ToolDef = {
  name: "get_activity_best_efforts",
  title: "Get Activity Best Efforts",
  description:
    "Best times over fixed distances (400 m, 1 km, 1 mile, 5 km, …) within ONE activity — the " +
    "numbers the Intervals.icu website shows in the activity's Pace tab under \"Best efforts\". " +
    "Read straight from the activity's pace curve (no interpolation): Intervals.icu computes " +
    "times at a fixed ladder of distances, and a requested distance not on the ladder is rounded " +
    "UP to the next ladder distance, as the website does (1609 → 1609.34; the row then carries " +
    "requested_m). Distances longer than the run are omitted. Returns rows of distance_m, time_s, " +
    "time (m:ss), pace_s_per_km, pace (m:ss/km). Set gap=true for grade-adjusted pace. " +
    "Use get_activities first to find the activity_id.",
  schema: {
    activity_id: z
      .string()
      .min(1)
      .refine(
        (s) => !/\s/.test(s) && !/[^\x20-\x7E]/.test(s),
        "This looks like an activity name, not an ID. " +
        "Call get_activities first to get the activity_id field (e.g. 'i12345678')."
      )
      .describe(
        "Intervals.icu activity ID — a short alphanumeric string like 'i12345678', " +
        "NOT the activity name. Call get_activities first to obtain IDs."
      ),
    distances_m: z
      .array(z.number().positive().max(1_000_000))
      .min(1)
      .max(40)
      .default(DEFAULT_BEST_EFFORT_DISTANCES_M)
      .describe(
        "Distances in meters. Default: 400, 800, 1000, 1500, 1609 (mile), 3000, 5000, 10000, " +
        "21097 (half), 42195 (marathon). Each is rounded up to the Intervals.icu ladder distance."
      ),
    gap: z
      .boolean()
      .default(false)
      .describe("true = grade-adjusted pace (GAP) best efforts."),
    raw: z
      .boolean()
      .default(false)
      .describe("true = return the whole pace curve from Intervals.icu instead of the compact rows."),
  },
  handler: async (
    { activity_id, distances_m, gap, raw }: {
      activity_id: string;
      distances_m: number[];
      gap: boolean;
      raw: boolean;
    },
    ctx?: ToolContext,
  ) => {
    const curve = await intervalsClient.getActivityPaceCurve(activity_id, gap, { signal: ctx?.signal });
    if (raw) return curve;

    const { efforts, omitted } = bestEffortsFromCurve((curve ?? {}) as PaceCurveLike, distances_m);
    return {
      activity_id,
      gap,
      efforts,
      ...(omitted.length > 0 ? { omitted_m: omitted } : {}),
    };
  },
};
