// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure helpers for pace-curve best efforts (no I/O).
 *
 * Intervals.icu computes best-effort times only at a fixed ladder of distances
 * (GET /pace_distances: …, 400, 402.335, …, 1609.34, …, 5000, …, 21097.5, …).
 * A requested distance that is not on the ladder is rounded UP to the next ladder
 * distance — observed on the API: 1609 → 1609.34, 1234 → 1280.16,
 * 21097 → 21097.5. `snapToLadder` reproduces that rule so the tools return exactly
 * the numbers the website shows, never an interpolated time.
 */

/** Distances returned by get_activity_best_efforts when none are given. */
export const DEFAULT_BEST_EFFORT_DISTANCES_M = [
  400, 800, 1000, 1500, 1609, 3000, 5000, 10000, 21097, 42195,
];

/** Float slack for ladder matching (ladder values carry float noise, e.g. 45.719997). */
const LADDER_EPSILON_M = 0.01;

/** The shape shared by GET /activity/{id}/pace-curve.json and the athlete curves. */
export interface PaceCurveLike {
  distance?: number[] | null;
  values?: (number | null)[] | null;
}

export interface EffortRow {
  distance_m: number;
  /** Present only when the requested distance was rounded up to a ladder distance. */
  requested_m?: number;
  time_s: number;
  /** "m:ss" or "h:mm:ss", as on the website. */
  time: string;
  pace_s_per_km: number;
  /** "m:ss/km". */
  pace: string;
}

/** Smallest ladder distance >= requested (ladder assumed ascending), or null if none. */
export function snapToLadder(requested: number, ladder: readonly number[]): number | null {
  for (const d of ladder) {
    if (d >= requested - LADDER_EPSILON_M) return d;
  }
  return null;
}

/** Index of `distance` in `ladder` (tolerant of float noise), or -1. */
export function ladderIndex(distance: number, ladder: readonly number[]): number {
  return ladder.findIndex((d) => Math.abs(d - distance) <= LADDER_EPSILON_M);
}

/** Seconds per km, rounded to 0.1 s. */
export function paceSecondsPerKm(distanceM: number, timeS: number): number {
  return Math.round((timeS / distanceM) * 10000) / 10;
}

/** 1653 → "27:33", 3725 → "1:02:05". Rounds to whole seconds. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 330.6 → "5:31/km" (rounded to whole seconds, like the website). */
export function formatPace(secondsPerKm: number): string {
  return `${formatDuration(secondsPerKm)}/km`;
}

/** Round a ladder distance for display (1609.34 stays 1609.34; 45.719997 → 45.72). */
function cleanDistance(d: number): number {
  return Math.round(d * 100) / 100;
}

export function effortRow(distanceM: number, timeS: number, requestedM?: number): EffortRow {
  const distance = cleanDistance(distanceM);
  const pace = paceSecondsPerKm(distanceM, timeS);
  return {
    distance_m: distance,
    ...(requestedM !== undefined && Math.abs(requestedM - distance) > LADDER_EPSILON_M
      ? { requested_m: requestedM }
      : {}),
    time_s: timeS,
    time: formatDuration(timeS),
    pace_s_per_km: pace,
    pace: formatPace(pace),
  };
}

/**
 * Best efforts for one activity at the requested distances, read straight off its
 * pace curve, shortest first. Distances beyond the run (no ladder point, or no
 * value) go to `omitted`; two requests that round up to the same ladder distance
 * yield one row (the first, i.e. shorter, request is kept as requested_m).
 */
export function bestEffortsFromCurve(
  curve: PaceCurveLike,
  requested: readonly number[],
): { efforts: EffortRow[]; omitted: number[] } {
  const ladder = curve.distance ?? [];
  const values = curve.values ?? [];
  const efforts: EffortRow[] = [];
  const omitted: number[] = [];
  const seen = new Set<number>();
  for (const req of [...new Set(requested)].sort((a, b) => a - b)) {
    const snapped = snapToLadder(req, ladder);
    const i = snapped === null ? -1 : ladderIndex(snapped, ladder);
    const t = i >= 0 ? values[i] : undefined;
    if (snapped === null || typeof t !== "number") {
      omitted.push(req);
      continue;
    }
    if (seen.has(i)) continue;
    seen.add(i);
    efforts.push(effortRow(snapped, t, req));
  }
  return { efforts, omitted };
}

/** One activity entry in GET /athlete/{id}/activity-pace-curves.json. */
export interface ActivityPaceCurveEntry {
  id: string;
  start_date_local?: string;
  /** Best time per distance, parallel to the payload's `distances`; shorter when the run was shorter. */
  secs?: (number | null)[] | null;
}

export interface ActivityPaceCurvesPayload {
  distances?: number[];
  gap?: boolean;
  curves?: ActivityPaceCurveEntry[];
}

export interface ActivityMeta {
  name?: string | null;
  distance?: number | null;
  type?: string | null;
}

export interface BulkEffortRow {
  activity_id: string;
  start_date_local: string | null;
  name: string | null;
  /** Total distance of the activity (m), for context. */
  activity_distance_m: number | null;
  /** Effort distance (the ladder distance actually used). */
  distance_m: number;
  time_s: number;
  time: string;
  pace_s_per_km: number;
  pace: string;
}

/**
 * Flatten activity-pace-curves payloads (one per date chunk, all requested with a
 * single distance) into rows, fastest first. Ties keep the earlier activity first,
 * so a record set first ranks first. Activities without the distance are dropped.
 */
export function rankBulkEfforts(
  payloads: readonly ActivityPaceCurvesPayload[],
  meta: ReadonlyMap<string, ActivityMeta>,
): BulkEffortRow[] {
  const rows: BulkEffortRow[] = [];
  const seen = new Set<string>();
  for (const p of payloads) {
    const distance = p.distances?.[0];
    if (distance === undefined) continue;
    for (const c of p.curves ?? []) {
      const t = c.secs?.[0];
      if (typeof t !== "number" || seen.has(c.id)) continue;
      seen.add(c.id);
      const m = meta.get(c.id);
      const e = effortRow(distance, t);
      rows.push({
        activity_id: c.id,
        start_date_local: c.start_date_local ?? null,
        name: m?.name ?? null,
        activity_distance_m: typeof m?.distance === "number" ? Math.round(m.distance) : null,
        distance_m: e.distance_m,
        time_s: e.time_s,
        time: e.time,
        pace_s_per_km: e.pace_s_per_km,
        pace: e.pace,
      });
    }
  }
  return rows.sort(
    (a, b) => a.time_s - b.time_s || (a.start_date_local ?? "").localeCompare(b.start_date_local ?? ""),
  );
}

/**
 * Split an inclusive YYYY-MM-DD range into calendar-year chunks:
 * ("2024-06-10", "2026-02-01") → [2024-06-10..2024-12-31], [2025-01-01..2025-12-31],
 * [2026-01-01..2026-02-01]. Empty when oldest > newest.
 */
export function yearChunks(oldest: string, newest: string): Array<[string, string]> {
  if (oldest > newest) return [];
  const chunks: Array<[string, string]> = [];
  const lastYear = Number(newest.slice(0, 4));
  for (let y = Number(oldest.slice(0, 4)); y <= lastYear; y++) {
    const start = y === Number(oldest.slice(0, 4)) ? oldest : `${y}-01-01`;
    const end = y === lastYear ? newest : `${y}-12-31`;
    chunks.push([start, end]);
  }
  return chunks;
}

/** Accepted `period` values for get_athlete_best_efforts. */
export const PERIOD_REGEX = /^(all|season|s0|\d{1,4}d|\d{1,2}y|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/;

/**
 * Map a user-facing period to an Intervals.icu curve id:
 * "all" → "all", "season" → "s0" (this season, per the athlete's settings),
 * "42d" / "1y" → as-is, "2025-01-01..2025-12-31" → "r.2025-01-01.2025-12-31".
 */
export function periodToCurveId(period: string): string {
  if (!PERIOD_REGEX.test(period)) {
    throw new Error(
      `Unsupported period "${period}". Use all, season, <N>d (e.g. 42d), <N>y (e.g. 1y), ` +
      `or YYYY-MM-DD..YYYY-MM-DD.`,
    );
  }
  if (period === "season") return "s0";
  const range = period.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (range) {
    if (range[1] > range[2]) throw new Error(`Invalid period "${period}": start is after end.`);
    return `r.${range[1]}.${range[2]}`;
  }
  return period;
}

/** Run async tasks with bounded concurrency, preserving input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
