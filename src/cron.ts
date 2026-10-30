// CronLens core: parse, explain, and simulate standard 5-field cron.
// Zero dependencies. Semantics follow Vixie/cronie crontab:
//  - fields: minute hour day-of-month month day-of-week
//  - day-of-month and day-of-week are OR'd when BOTH are restricted
//    (that OR is the single most misunderstood cron behaviour).
//  - day-of-week 7 is Sunday, normalised to 0.
//  - steps (*/n) are anchored to the field's origin, never to "now".

export class CronError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CronError";
  }
}

export interface FieldDef {
  key: "minute" | "hour" | "dom" | "month" | "dow";
  label: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

export const FIELD_DEFS: FieldDef[] = [
  { key: "minute", label: "Minute", min: 0, max: 59 },
  { key: "hour", label: "Hour", min: 0, max: 23 },
  { key: "dom", label: "Day of month", min: 1, max: 31 },
  {
    key: "month",
    label: "Month",
    min: 1,
    max: 12,
    names: {
      JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
      JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
    },
  },
  {
    key: "dow",
    label: "Day of week",
    min: 0,
    max: 7,
    names: { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 },
  },
];

export interface ParsedField {
  def: FieldDef;
  raw: string;
  values: Set<number>;
  restricted: boolean;
  /** Step size when the field is a step expression, else null. */
  step: number | null;
  /** True when the raw text used 7 for Sunday. */
  usedSevenAsSunday: boolean;
}

export interface Schedule {
  fields: ParsedField[];
  /** The 5-field expression this schedule came from (shortcuts expanded). */
  expression: string;
  /** Shortcut the user typed, e.g. "@daily", if any. */
  shortcut?: string;
  /** True for @reboot, which has no schedule at all. */
  reboot?: boolean;
}

const SHORTCUTS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parseValue(token: string, def: FieldDef): number {
  const upper = token.toUpperCase();
  if (def.names && upper in def.names) return def.names[upper] as number;
  if (!/^\d+$/.test(token)) {
    throw new CronError(
      `"${token}" is not a valid ${def.label.toLowerCase()} value`,
      def.label,
      def.names
        ? `Use ${def.min}–${def.max} or a name (${Object.keys(def.names).join(", ")}).`
        : `Use ${def.min}–${def.max}.`,
    );
  }
  const n = Number(token);
  if (n < def.min || n > def.max) {
    throw new CronError(
      `${n} is out of range for ${def.label.toLowerCase()} (${def.min}–${def.max})`,
      def.label,
    );
  }
  return n;
}

function addRange(
  values: Set<number>,
  start: number,
  end: number,
  step: number,
  def: FieldDef,
): void {
  if (start > end) {
    throw new CronError(
      `Range ${start}-${end} is reversed in ${def.label.toLowerCase()}`,
      def.label,
      "Cron ranges do not wrap around — use a list instead, e.g. 22,23,0,1.",
    );
  }
  for (let v = start; v <= end; v += step) values.add(v);
}

export function parseField(raw: string, def: FieldDef): ParsedField {
  const token = raw.trim();
  if (token === "") {
    throw new CronError(`Missing ${def.label.toLowerCase()} field`, def.label);
  }
  if (token.includes("?")) {
    throw new CronError(
      `"?" is Quartz syntax, not crontab syntax`,
      def.label,
      `Use * for "any" in ${def.label.toLowerCase()}.`,
    );
  }
  if (!/^[A-Za-z0-9*,/-]+$/.test(token)) {
    throw new CronError(
      `Invalid characters in ${def.label.toLowerCase()} field: "${token}"`,
      def.label,
      "Allowed: digits, names, *, comma, hyphen, slash.",
    );
  }
  const values = new Set<number>();
  let step: number | null = null;
  let usedSevenAsSunday = false;
  for (const part of token.split(",")) {
    if (part === "") {
      throw new CronError(
        `Empty item in ${def.label.toLowerCase()} list (check for a trailing comma)`,
        def.label,
      );
    }
    const slash = part.split("/");
    if (slash.length > 2) {
      throw new CronError(
        `Too many "/" in ${def.label.toLowerCase()} field: "${part}"`,
        def.label,
      );
    }
    let partStep = 1;
    if (slash.length === 2) {
      const stepText = slash[1] as string;
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new CronError(
          `Step must be a positive number in ${def.label.toLowerCase()} field: "${part}"`,
          def.label,
        );
      }
      partStep = Number(stepText);
      step = partStep;
    }
    const base = slash[0] as string;
    if (base === "*") {
      addRange(values, def.min, def.max, partStep, def);
    } else if (base.includes("-")) {
      const [a, b] = base.split("-");
      addRange(values, parseValue(a as string, def), parseValue(b as string, def), partStep, def);
    } else {
      const v = parseValue(base, def);
      if (def.key === "dow" && v === 7) usedSevenAsSunday = true;
      // A bare value matches only itself; "2/5" steps from 2 to the field max.
      if (slash.length === 2) addRange(values, v, def.max, partStep, def);
      else values.add(v);
    }
  }
  // Normalise Sunday: 7 -> 0 for day-of-week.
  if (def.key === "dow" && values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  return {
    def,
    raw: token,
    values,
    restricted: token !== "*",
    step,
    usedSevenAsSunday,
  };
}

export function parseCron(input: string): Schedule {
  const text = input.trim().replace(/\s+/g, " ");
  if (text === "") throw new CronError("Empty expression — type five fields, e.g. 0 9 * * 1-5");
  if (text.startsWith("@")) {
    const lower = text.toLowerCase();
    if (lower === "@reboot") {
      return { fields: [], expression: "@reboot", shortcut: "@reboot", reboot: true };
    }
    const expanded = SHORTCUTS[lower];
    if (!expanded) {
      throw new CronError(
        `Unknown shortcut "${text}"`,
        undefined,
        "Known shortcuts: @yearly, @monthly, @weekly, @daily, @hourly, @reboot.",
      );
    }
    return { ...parseCron(expanded), expression: expanded, shortcut: lower };
  }
  const parts = text.split(" ");
  if (parts.length === 6) {
    // Most likely a seconds-first (Quartz/Spring) expression pasted into crontab.
    let hint = "Standard crontab has five fields and no seconds field.";
    try {
      const rest = parseCron(parts.slice(1).join(" "));
      void rest;
      hint = `This looks like a seconds-first expression (Quartz/Spring). Dropping the first field gives "${parts.slice(1).join(" ")}".`;
    } catch {
      /* keep the generic hint */
    }
    throw new CronError(
      `Six fields found — standard cron has five (minute hour day-of-month month day-of-week)`,
      undefined,
      hint,
    );
  }
  if (parts.length !== 5) {
    throw new CronError(
      `Expected five fields, found ${parts.length}`,
      undefined,
      "Order: minute hour day-of-month month day-of-week — e.g. 0 9 * * 1-5.",
    );
  }
  const fields = parts.map((p, i) => parseField(p as string, FIELD_DEFS[i] as FieldDef));
  return { fields, expression: parts.join(" ") };
}

export function matches(date: Date, schedule: Schedule): boolean {
  if (schedule.reboot || schedule.fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = schedule.fields as [ParsedField, ParsedField, ParsedField, ParsedField, ParsedField];
  if (!minute.values.has(date.getMinutes())) return false;
  if (!hour.values.has(date.getHours())) return false;
  if (!month.values.has(date.getMonth() + 1)) return false;
  const domMatch = dom.values.has(date.getDate());
  const dowMatch = dow.values.has(date.getDay());
  if (dom.restricted && dow.restricted) return domMatch || dowMatch;
  if (dom.restricted) return domMatch;
  if (dow.restricted) return dowMatch;
  return true;
}

/** Next `count` run times strictly after `from`, searching up to `maxYears` ahead. */
export function nextRuns(schedule: Schedule, from: Date, count: number, maxYears = 4): Date[] {
  const out: Date[] = [];
  if (schedule.reboot) return out;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const cap = maxYears * 366 * 24 * 60;
  for (let i = 0; i < cap && out.length < count; i++) {
    if (matches(cursor, schedule)) out.push(new Date(cursor.getTime()));
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return out;
}

/** Run times in the next `days` days, grouped by calendar day (for the week grid). */
export function runsByDay(schedule: Schedule, from: Date, days: number): { date: Date; times: string[] }[] {
  const result: { date: Date; times: string[] }[] = [];
  if (schedule.reboot) return result;
  const start = new Date(from.getTime());
  start.setHours(0, 0, 0, 0);
  for (let d = 0; d < days; d++) {
    const day = new Date(start.getTime());
    day.setDate(day.getDate() + d);
    result.push({ date: day, times: [] });
  }
  const cursor = new Date(start.getTime());
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + days);
  while (cursor < end) {
    if (cursor >= from && matches(cursor, schedule)) {
      const idx = Math.floor((cursor.getTime() - start.getTime()) / 86400000);
      const bucket = result[idx];
      if (bucket && bucket.times.length < 24) bucket.times.push(fmtTime(cursor));
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return result;
}

export function countRunsInWindow(schedule: Schedule, from: Date, days: number): number {
  if (schedule.reboot) return 0;
  let count = 0;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const end = new Date(from.getTime());
  end.setDate(end.getDate() + days);
  while (cursor < end) {
    if (matches(cursor, schedule)) count++;
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return count;
}

// ---------- Describing ----------

const pad = (n: number) => String(n).padStart(2, "0");
export const fmtTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function fmtDateTime(d: Date): string {
  return `${DOW_NAMES[d.getDay()]}, ${pad(d.getDate())} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()} at ${fmtTime(d)}`;
}
export function relativeIn(from: Date, to: Date): string {
  const mins = Math.round((to.getTime() - from.getTime()) / 60000);
  if (mins < 1) return "in under a minute";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const rh = hours % 24;
  return rh === 0 ? `in ${days}d` : `in ${days}d ${rh}h`;
}

function sortedValues(f: ParsedField): number[] {
  return [...f.values].sort((a, b) => a - b);
}

function listText(values: number[], nameFn?: (n: number) => string): string {
  const shown = values.slice(0, 8).map((v) => (nameFn ? nameFn(v) : String(v)));
  if (values.length > 8) shown.push(`+${values.length - 8} more`);
  return shown.join(", ");
}

function stepText(f: ParsedField): string | null {
  if (f.step === null || f.step <= 1) return null;
  const m = f.raw.match(/^\*\/(\d+)$/);
  if (m) return `every ${m[1]}`;
  return `every ${f.step}`;
}

export function fieldMeaning(f: ParsedField): string {
  const values = sortedValues(f);
  const full = values.length === f.def.max - f.def.min + 1 &&
    (f.def.key !== "dow" || values.length === 7);
  if (!f.restricted) return "Every value";
  const step = stepText(f);
  if (f.def.key === "month") {
    if (full) return "Every month";
    if (step) return `${step} months, starting ${MONTH_NAMES[(values[0] as number) - 1]}`;
    return `Month${values.length > 1 ? "s" : ""} ${listText(values, (v) => MONTH_NAMES[v - 1] as string)}`;
  }
  if (f.def.key === "dow") {
    if (full) return "Every day of the week";
    if (step) return `${step} days, starting ${DOW_NAMES[values[0] as number]}`;
    return listText(values, (v) => DOW_NAMES[v] as string);
  }
  if (f.def.key === "dom") {
    if (step) return `${step} days of the month`;
    return `Day${values.length > 1 ? "s" : ""} ${listText(values)} of the month`;
  }
  if (f.def.key === "hour") {
    if (step) return `${step} hours`;
    return values.length === 1 ? `Hour ${pad(values[0] as number)}` : `Hours ${listText(values, pad)}`;
  }
  if (step) return `${step} minutes`;
  return values.length === 1 ? `Minute ${values[0]}` : `Minutes ${listText(values)}`;
}

function timePhrase(minute: ParsedField, hour: ParsedField): string {
  const m = sortedValues(minute);
  const h = sortedValues(hour);
  const mStep = stepText(minute);
  const hStep = stepText(hour);
  if (!minute.restricted && !hour.restricted) return "Every minute";
  if (mStep && !hour.restricted) return `Every ${minute.step} minutes`;
  if (!minute.restricted && h.length === 1) return `Every minute of hour ${pad(h[0] as number)}`;
  if (m.length === 1 && h.length === 1) return `At ${pad(h[0] as number)}:${pad(m[0] as number)}`;
  if (m.length === 1 && !hour.restricted) return `At ${pad(m[0] as number)} minutes past every hour`;
  if (m.length === 1 && hStep) return `At ${pad(m[0] as number)} minutes past every ${hour.step} hours`;
  if (m.length === 1) return `At minute ${pad(m[0] as number)} of hours ${listText(h, pad)}`;
  if (h.length === 1) return `At ${pad(h[0] as number)}:${listText(m, pad)}`;
  return `At minutes ${listText(m)} of hours ${listText(h, pad)}`;
}

export function describe(schedule: Schedule): string {
  if (schedule.reboot) return "Runs once when the machine (re)boots — it has no recurring schedule.";
  const [minute, hour, dom, month, dow] = schedule.fields as [ParsedField, ParsedField, ParsedField, ParsedField, ParsedField];
  const time = timePhrase(minute, hour);
  let day: string;
  if (!dom.restricted && !dow.restricted) day = "every day";
  else if (dom.restricted && !dow.restricted) day = `on day${sortedValues(dom).length > 1 ? "s" : ""} ${listText(sortedValues(dom))} of the month`;
  else if (!dom.restricted && dow.restricted) day = `on ${listText(sortedValues(dow), (v) => DOW_NAMES[v] as string)}`;
  else day = `on day${sortedValues(dom).length > 1 ? "s" : ""} ${listText(sortedValues(dom))} of the month OR on ${listText(sortedValues(dow), (v) => DOW_NAMES[v] as string)} — either one matches`;
  const monthPart = month.restricted ? ` in ${listText(sortedValues(month), (v) => MONTH_NAMES[v - 1] as string)}` : "";
  return `${time}, ${day}${monthPart}.`;
}

// ---------- Gotchas ----------

export interface Gotcha {
  level: "error" | "warn" | "info";
  title: string;
  detail: string;
}

export function detectGotchas(schedule: Schedule, next: Date[]): Gotcha[] {
  const out: Gotcha[] = [];
  if (schedule.reboot) {
    out.push({
      level: "info",
      title: "@reboot has no schedule",
      detail: "It runs once at startup. There are no next run times to show, and it is not supported by GitHub Actions or AWS EventBridge — use a five-field expression there.",
    });
    return out;
  }
  const [minute, hour, dom, month, dow] = schedule.fields as [ParsedField, ParsedField, ParsedField, ParsedField, ParsedField];
  if (dom.restricted && dow.restricted) {
    out.push({
      level: "warn",
      title: "Day-of-month OR day-of-week — not AND",
      detail: `Both day fields are set, so this runs when EITHER matches: on day ${listText(sortedValues(dom))} of the month, or on ${listText(sortedValues(dow), (v) => DOW_NAMES[v] as string)}. It does NOT mean "only when both fall on the same day". If you meant the overlap, check it in the script itself.`,
    });
  }
  for (const f of schedule.fields) {
    if (f.step !== null && f.step > 1) {
      const anchor = f.def.key === "minute" ? "the hour (:00)" : f.def.key === "hour" ? "midnight" : f.def.key === "dom" ? "the 1st of the month" : f.def.key === "month" ? "January" : "Sunday";
      out.push({
        level: "info",
        title: `*/${f.step} in ${f.def.label.toLowerCase()} is anchored, not relative`,
        detail: `It fires on values divisible from ${anchor} — not ${f.step} ${f.def.key === "minute" ? "minutes" : f.def.key === "hour" ? "hours" : "units"} after you deploy. If you deploy at :07, */15 still fires at :15, not :22.`,
      });
    }
    if (f.step !== null && f.step > f.def.max - f.def.min + 1) {
      out.push({
        level: "warn",
        title: `Step larger than the ${f.def.label.toLowerCase()} range`,
        detail: `*/${f.step} only ever matches one value in this field. You probably meant a smaller step.`,
      });
    }
  }
  if (dow.usedSevenAsSunday) {
    out.push({
      level: "info",
      title: "7 means Sunday here",
      detail: "Both 0 and 7 mean Sunday in crontab. CronLens normalised 7 to 0, so the schedule is unchanged — just don't be surprised when another tool shows 0.",
    });
  }
  if (next.length === 0) {
    out.push({
      level: "error",
      title: "This schedule never runs",
      detail: "No matching minute exists in the next four years. The usual cause is an impossible date, e.g. 30 February — check the day-of-month against the month field.",
    });
  } else {
    // Warn when some selected months can never contain some selected days.
    if (dom.restricted && month.restricted) {
      const daysIn = (m: number) => (m === 2 ? 29 : [4, 6, 9, 11].includes(m) ? 30 : 31);
      const impossible = sortedValues(dom).filter((d) => sortedValues(month).every((m) => d > daysIn(m)));
      const skipped = sortedValues(dom).filter((d) => sortedValues(month).some((m) => d > daysIn(m)) && !impossible.includes(d));
      if (impossible.length > 0) {
        out.push({
          level: "error",
          title: "Impossible day for every selected month",
          detail: `Day ${listText(impossible)} never occurs in ${listText(sortedValues(month), (v) => MONTH_NAMES[v - 1] as string)}.`,
        });
      } else if (skipped.length > 0) {
        out.push({
          level: "warn",
          title: "Some months skip this day",
          detail: `Day ${listText(skipped)} does not exist in every selected month (e.g. February has no 30th), so those months are silently skipped.`,
        });
      }
    }
  }
  if (!minute.restricted && !hour.restricted && !dom.restricted && !month.restricted && !dow.restricted) {
    out.push({
      level: "info",
      title: "Runs every minute — 1,440 times a day",
      detail: "That is fine for a heartbeat, but make sure the job is fast and idempotent, or overlapping runs will stack up. Consider flock to skip a run while the previous one is still going.",
    });
  }
  out.push({
    level: "info",
    title: "No timezone in this expression",
    detail: "A cron line carries no timezone — it runs in whatever timezone your scheduler uses (crontab: the server; GitHub Actions / EventBridge: UTC). The times on this page are shown in your browser's local timezone.",
  });
  return out;
}

export const PRESETS: { label: string; expr: string }[] = [
  { label: "Every minute", expr: "* * * * *" },
  { label: "Every 15 min", expr: "*/15 * * * *" },
  { label: "Hourly", expr: "0 * * * *" },
  { label: "Daily at midnight", expr: "0 0 * * *" },
  { label: "Weekdays at 9am", expr: "0 9 * * 1-5" },
  { label: "Sundays at 3:30am", expr: "30 3 * * 0" },
  { label: "1st of month", expr: "0 0 1 * *" },
  { label: "New Year's Day", expr: "0 0 1 1 *" },
];

export const GOTCHA_EXAMPLES: { label: string; expr: string; note: string }[] = [
  { label: "The OR trap", expr: "0 0 1 * 1", note: "1st of the month OR every Monday — not Mondays that are the 1st." },
  { label: "Never runs", expr: "30 2 30 2 *", note: "30 February does not exist." },
  { label: "Anchored steps", expr: "*/15 * * * *", note: "Fires at :00, :15, :30, :45 — not 15 min after deploy." },
  { label: "Six-field confusion", expr: "0 0 9 * * *", note: "Seconds-first (Quartz/Spring) pasted into crontab." },
];
