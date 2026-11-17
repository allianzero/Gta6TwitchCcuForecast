// GTA VI launch-day Twitch viewer forecast.
//
// The program forecasts, for each hour 2..24 of a game's release day (UTC),
// five quantiles of the Twitch category's concurrent viewers, from everything
// known at the end of hour 1: that hour's print, the category's own history,
// and the launch-day curves of past big game launches shipped in the case.
//
// Method (all in log space, where a miss of 20% costs the same at any size):
//
//  1. For every past launch in the case ("comparable"), take its release-day
//     curve as log ratios to its own hour-1 print, and its day peak as
//     x = log(peak / hour 1). Launches whose day peak is more than 15x their
//     hour 1 are left out: those unlocked once, globally, late in the day,
//     so their hour 1 was still pre-launch and their curve is a different
//     shape (a single unlock spike) from a rolling-midnight launch like
//     GTA VI, whose hour 1 already holds the UK, European and Oceania
//     unlocks.
//  2. Predict this launch's x from one pre-launch signal: how hour 1 compares
//     with the busiest hour of the day before it, f = log(hour1 / pre24max).
//     When hour 1 already towers over the day before, the day's peak sits
//     close above it; when hour 1 is small next to the day-before ramp (only
//     New Zealand and Australia live so far), the peak runs far above hour 1.
//     The link is a straight line fitted on the comparables.
//  3. For each hour h, fit log(viewers_h / hour1) = a_h + b_h * x on the
//     comparables: early hours barely move with x (the night dip), evening
//     hours move almost one-for-one with it (the US prime-time peak). The
//     median is a_h + b_h * x_hat; the spread is the residual spread around
//     that line, widened 1.3x with a 0.25 log floor, so the 5%-95% band
//     covers about nine hours in ten.
//  4. If anything is missing (no usable history, too few comparables), fall
//     back to a flat persistence forecast around hour 1, so the run still
//     writes a valid file.
//
// Everything is a pure function of the case file: no clock, no randomness,
// no network, so two runs write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The standard normal's quantile at each scored level. */
const Z_BY_LEVEL: Record<number, number> = {
  0.05: -1.645,
  0.25: -0.674,
  0.5: 0,
  0.75: 0.674,
  0.95: 1.645,
};
const STANDARD_LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** A comparable whose day peak is more than this many times its hour 1 is a
 *  different kind of launch (one late global unlock) and is left out. */
const PEAK_RATIO_CAP = 15;
/** The residual spread is widened by this much; the floor keeps honest
 *  uncertainty even where past launches agree closely. */
const SPREAD_MULT = 1.3;
const SPREAD_FLOOR = 0.25;
/** The persistence fallback's spread in log units per square-root hour. */
const FALLBACK_SIGMA = 0.15;
/** Quantiles are clipped to this range of viewers. */
const MAX_VIEWERS = 1_000_000_000;

interface HourlyPoint {
  from?: string;
  at?: string;
  viewers?: number;
}

interface Comparable {
  name: string;
  day_start: string;
  hourly: HourlyPoint[];
}

interface CaseFile {
  day_start?: string;
  levels?: number[];
  known?: Array<{ hour: number; viewers: number }>;
  forecast?: Array<{ hour: number }>;
  history?: HourlyPoint[];
  history_hourly?: HourlyPoint[];
  comparables?: Comparable[];
}

/** Whole hours between an instant and the release day's start. */
const hourOffset = (instant: string, dayStartMs: number): number =>
  Math.floor((Date.parse(instant) - dayStartMs) / 3_600_000);

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The least-squares line y = a + b*x through the points, as [a, b]. */
const ols = (xs: number[], ys: number[]): [number, number] => {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  const b = den === 0 ? 0 : num / den;
  return [my - b * mx, b];
};

/** Population standard deviation. */
const pstdev = (values: number[]): number => {
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - m) * (x - m), 0) / values.length;
  return Math.sqrt(v);
};

/**
 * A launch's release-day curve: hour (1..24) -> viewers, from its hourly
 * points measured against its own day_start. Points outside the day are
 * ignored; a missing hour stays missing.
 */
const releaseDayProfile = (comp: Comparable): Map<number, number> => {
  const dayStartMs = Date.parse(comp.day_start);
  const profile = new Map<number, number>();
  for (const point of comp.hourly ?? []) {
    if (point.viewers === undefined || point.viewers === null) continue;
    const instant = point.from ?? point.at;
    if (instant === undefined) continue;
    const hour = hourOffset(instant, dayStartMs) + 1;
    if (hour >= 1 && hour <= 24 && point.viewers > 0) {
      profile.set(hour, point.viewers);
    }
  }
  return profile;
};

/**
 * The busiest hour in the day before the release day (plus the release
 * day's first hour itself, which the history already holds): the peak of
 * the pre-launch ramp, against which hour 1 is judged. Whole-hour means
 * are used where they exist; minute reads are bucketed into whole hours
 * first, so the two sources measure the same thing.
 */
const preDayMax = (c: CaseFile): number | null => {
  if (c.day_start === undefined) return null;
  const dayStartMs = Date.parse(c.day_start);
  const hourly = c.history_hourly ?? [];
  let best: number | null = null;
  for (const point of hourly) {
    if (point.viewers === undefined || point.viewers === null) continue;
    const instant = point.from ?? point.at;
    if (instant === undefined) continue;
    const k = hourOffset(instant, dayStartMs);
    if (k >= -24 && k <= 0 && point.viewers > 0) {
      best = best === null ? point.viewers : Math.max(best, point.viewers);
    }
  }
  if (best !== null) return best;
  // No whole-hour means: bucket the minute reads into whole hours.
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const point of c.history ?? []) {
    if (point.viewers === undefined || point.viewers === null) continue;
    const instant = point.at ?? point.from;
    if (instant === undefined) continue;
    const k = hourOffset(instant, dayStartMs);
    if (k < -24 || k > 0) continue;
    const bucket = buckets.get(k) ?? { sum: 0, n: 0 };
    bucket.sum += point.viewers;
    bucket.n += 1;
    buckets.set(k, bucket);
  }
  for (const { sum, n } of buckets.values()) {
    const mean = sum / n;
    best = best === null ? mean : Math.max(best, mean);
  }
  return best;
};

/** The same pre-day peak for one comparable, from its own hourly points. */
const comparablePreDayMax = (comp: Comparable): number | null => {
  const dayStartMs = Date.parse(comp.day_start);
  let best: number | null = null;
  for (const point of comp.hourly ?? []) {
    if (point.viewers === undefined || point.viewers === null) continue;
    const instant = point.from ?? point.at;
    if (instant === undefined) continue;
    const k = hourOffset(instant, dayStartMs);
    if (k >= -24 && k <= 0 && point.viewers > 0) {
      best = best === null ? point.viewers : Math.max(best, point.viewers);
    }
  }
  return best;
};

/** The flat persistence fallback: every hour stays near hour 1. */
const fallbackQuantiles = (p1: number, hour: number, zs: number[]): number[] => {
  const spread = FALLBACK_SIGMA * Math.sqrt(hour - 1);
  let prev = 0;
  return zs.map((z) => {
    const q = round2(Math.min(MAX_VIEWERS, Math.max(1, p1 * Math.exp(z * spread))));
    const out = Math.max(q, prev);
    prev = out;
    return out;
  });
};

/** Forecast one case: 23 rows, hours 2..24, five quantiles each. */
const forecastCase = (c: CaseFile): Array<{ hour: number; q: number[] }> => {
  const levels = c.levels !== undefined && c.levels.length === STANDARD_LEVELS.length
    ? c.levels
    : STANDARD_LEVELS;
  const zs = levels.map((t) => {
    let best = STANDARD_LEVELS[0];
    let bestDist = Math.abs(t - best);
    for (const s of STANDARD_LEVELS) {
      if (Math.abs(t - s) < bestDist) {
        best = s;
        bestDist = Math.abs(t - s);
      }
    }
    return Z_BY_LEVEL[best];
  });

  const first = (c.known ?? []).find((k) => k.hour === 1);
  const p1 = Math.max(1, first !== undefined && first.viewers > 0 ? first.viewers : 1);
  const hours = (c.forecast ?? []).map((f) => f.hour).filter((h) => h >= 2 && h <= 24);
  const wanted = hours.length === 23 ? hours : Array.from({ length: 23 }, (_, i) => i + 2);

  // The shape library: past launches with a full release day whose hour 1
  // was already a live hour (rolling-midnight unlocks). The target game's
  // own pre-release history is not a launch and is left out.
  const library: Array<{ profile: Map<number, number>; x: number; f: number }> = [];
  for (const comp of c.comparables ?? []) {
    if (comp.name.startsWith('Grand Theft Auto VI')) continue;
    const profile = releaseDayProfile(comp);
    if (profile.size < 23 || !profile.has(1)) continue;
    const h1 = profile.get(1) as number;
    let peak = 0;
    for (const v of profile.values()) peak = Math.max(peak, v);
    if (peak / h1 >= PEAK_RATIO_CAP) continue;
    const pre = comparablePreDayMax(comp);
    library.push({
      profile,
      x: Math.log(peak / h1),
      f: pre !== null && pre > 0 ? Math.log(h1 / pre) : 0,
    });
  }

  // Too little to learn from: stay near hour 1.
  if (library.length < 5) {
    return wanted.map((hour) => ({ hour, q: fallbackQuantiles(p1, hour, zs) }));
  }

  // How far this launch's peak sits above its hour 1, from the pre-launch
  // ramp. Clamped to the range past launches actually showed, so one odd
  // signal cannot push the forecast off the map.
  const xs = library.map((e) => e.x);
  const fs = library.map((e) => e.f);
  const [ax, bx] = ols(fs, xs);
  const pre = preDayMax(c);
  const fTarget = pre !== null && pre > 0 ? Math.log(p1 / pre) : 0;
  const xMean = xs.reduce((s, v) => s + v, 0) / xs.length;
  let xHat = pre === null ? xMean : ax + bx * fTarget;
  xHat = Math.min(Math.max(xHat, Math.min(...xs)), Math.max(...xs));

  return wanted.map((hour) => {
    const ys: number[] = [];
    const xRows: number[] = [];
    for (const entry of library) {
      const v = entry.profile.get(hour);
      if (v !== undefined && v > 0) {
        ys.push(Math.log(v / (entry.profile.get(1) as number)));
        xRows.push(entry.x);
      }
    }
    if (xRows.length < 5) return { hour, q: fallbackQuantiles(p1, hour, zs) };
    const [ah, bh] = ols(xRows, ys);
    const residuals = ys.map((y, i) => y - (ah + bh * xRows[i]));
    const spread = Math.max(pstdev(residuals), SPREAD_FLOOR) * SPREAD_MULT;
    const median = ah + bh * xHat;
    let prev = 0;
    const q = zs.map((z) => {
      const value = round2(Math.min(MAX_VIEWERS, Math.max(1, p1 * Math.exp(median + z * spread))));
      const out = Math.max(value, prev);
      prev = out;
      return out;
    });
    return { hour, q };
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
