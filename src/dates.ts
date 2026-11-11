/**
 * Calendar maths lives in code, not in the model: LLMs are unreliable at
 * "what date was last Tuesday". We resolve relative phrases up front and hand
 * the model absolute dates.
 */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

export type Ymd = { y: number; m: number; d: number };
export type DateHint = { phrase: string; from: string; to: string };

const pad = (n: number) => String(n).padStart(2, "0");
const toUtc = (x: Ymd) => Date.UTC(x.y, x.m - 1, x.d);
const fromUtc = (ms: number): Ymd => {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
export const iso = (x: Ymd) => `${x.y}-${pad(x.m)}-${pad(x.d)}`;
const addDays = (x: Ymd, n: number) => fromUtc(toUtc(x) + n * 86_400_000);
const weekdayOf = (x: Ymd) => new Date(toUtc(x)).getUTCDay();

export function safeTz(tz: unknown): string {
  if (typeof tz !== "string" || !tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Calendar date of an instant in the user's timezone. */
export function localYmd(ms: number, tz: string): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(ms);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: g("year"), m: g("month"), d: g("day") };
}

function tzOffsetMs(ms: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ms);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function startOfDay(x: Ymd, tz: string): number {
  const guess = toUtc(x);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

/** [start, end) epoch-ms range covering `from`..`to` (inclusive days) in tz. */
export function rangeMs(from: string, to: string, tz: string): [number, number] {
  const f = from.split("-").map(Number);
  const t = to.split("-").map(Number);
  const start = startOfDay({ y: f[0], m: f[1], d: f[2] }, tz);
  const end = startOfDay(addDays({ y: t[0], m: t[1], d: t[2] }, 1), tz);
  return [start, end];
}

export function describeNow(ms: number, tz: string): string {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(ms);
  return `${s} (${tz})`;
}

function mostRecentPast(today: Ymd, weekday: number): Ymd {
  let diff = (weekdayOf(today) - weekday + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(today, -diff);
}

/** Resolve relative/partial date phrases in `text` to absolute dates. */
export function resolveDates(text: string, now: number, tz: string): DateHint[] {
  const today = localYmd(now, tz);
  const hints: DateHint[] = [];
  let rest = text.toLowerCase();
  const take = (re: RegExp, fn: (m: RegExpExecArray) => Ymd | [Ymd, Ymd] | null) => {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const r = fn(m);
      if (r) {
        const [a, b] = Array.isArray(r) ? r : [r, r];
        hints.push({ phrase: m[0].trim(), from: iso(a), to: iso(b) });
      }
      return " ";
    });
  };

  const wd = WEEKDAYS.join("|");
  const mo = [...MONTHS, "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sept?", "oct", "nov", "dec"].join("|");
  const monIdx = (t: string) => MONTHS.findIndex((m) => m.startsWith(t.slice(0, 3)));

  take(/\byesterday\b/g, () => addDays(today, -1));
  take(/\blast week\b/g, () => {
    const monThis = addDays(today, -((weekdayOf(today) + 6) % 7));
    return [addDays(monThis, -7), addDays(monThis, -1)];
  });
  take(new RegExp(`\\blast (${wd})\\b`, "g"), (m) => mostRecentPast(today, WEEKDAYS.indexOf(m[1])));
  take(/\b(\d{1,3}) (day|week|month)s? ago\b/g, (m) => {
    const n = Number(m[1]);
    if (m[2] === "day") return addDays(today, -n);
    if (m[2] === "week") return addDays(today, -7 * n);
    return addDays(today, -30 * n);
  });
  const monthDay = (month: number, day: number): Ymd | null => {
    if (day < 1 || day > 31) return null;
    let cand: Ymd = { y: today.y, m: month + 1, d: day };
    if (toUtc(cand) > toUtc(today)) cand = { ...cand, y: today.y - 1 };
    return cand;
  };
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${mo})\\b`, "g"), (m) =>
    monthDay(monIdx(m[2]), Number(m[1])));
  take(new RegExp(`\\b(${mo}) (\\d{1,2})(?:st|nd|rd|th)?\\b`, "g"), (m) =>
    monthDay(monIdx(m[1]), Number(m[2])));
  take(new RegExp(`\\b(${wd})\\b`, "g"), (m) => mostRecentPast(today, WEEKDAYS.indexOf(m[1])));

  return hints;
}
