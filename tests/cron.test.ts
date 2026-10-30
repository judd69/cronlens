import { describe, expect, it } from "vitest";
import {
  CronError,
  countRunsInWindow,
  describe as describeSchedule,
  detectGotchas,
  fieldMeaning,
  matches,
  nextRuns,
  parseCron,
  parseField,
  FIELD_DEFS,
} from "../src/cron";

const local = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0, 0);

describe("parseField", () => {
  it("parses wildcards, lists, ranges and steps", () => {
    const minute = FIELD_DEFS[0]!;
    expect([...parseField("*", minute).values].length).toBe(60);
    expect([...parseField("0,15,30,45", minute).values]).toEqual([0, 15, 30, 45]);
    expect([...parseField("1-5", minute).values]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseField("*/15", minute).values]).toEqual([0, 15, 30, 45]);
    expect([...parseField("2/15", minute).values]).toEqual([2, 17, 32, 47]);
    expect([...parseField("1-10/3", minute).values]).toEqual([1, 4, 7, 10]);
  });
  it("a bare value matches only itself", () => {
    expect([...parseField("30", FIELD_DEFS[0]!).values]).toEqual([30]);
    expect([...parseField("9", FIELD_DEFS[1]!).values]).toEqual([9]);
  });
  it("parses month and weekday names case-insensitively", () => {
    expect([...parseField("jan,jun", FIELD_DEFS[3]!).values]).toEqual([1, 6]);
    expect([...parseField("MON-FRI", FIELD_DEFS[4]!).values]).toEqual([1, 2, 3, 4, 5]);
  });
  it("normalises Sunday 7 to 0 and flags it", () => {
    const f = parseField("7", FIELD_DEFS[4]!);
    expect([...f.values]).toEqual([0]);
    expect(f.usedSevenAsSunday).toBe(true);
  });
  it("rejects out-of-range values, reversed ranges, zero steps and ?", () => {
    expect(() => parseField("60", FIELD_DEFS[0]!)).toThrow(CronError);
    expect(() => parseField("5-1", FIELD_DEFS[0]!)).toThrow(CronError);
    expect(() => parseField("*/0", FIELD_DEFS[0]!)).toThrow(CronError);
    expect(() => parseField("?", FIELD_DEFS[2]!)).toThrow(CronError);
    expect(() => parseField("32", FIELD_DEFS[2]!)).toThrow(CronError);
  });
  it("marks only non-* fields as restricted", () => {
    expect(parseField("*", FIELD_DEFS[0]!).restricted).toBe(false);
    expect(parseField("*/2", FIELD_DEFS[0]!).restricted).toBe(true);
  });
});

describe("parseCron", () => {
  it("expands shortcuts", () => {
    expect(parseCron("@daily").expression).toBe("0 0 * * *");
    expect(parseCron("@weekly").expression).toBe("0 0 * * 0");
    expect(parseCron("@hourly").expression).toBe("0 * * * *");
    expect(parseCron("@reboot").reboot).toBe(true);
    expect(() => parseCron("@nope")).toThrow(CronError);
  });
  it("rejects six fields with a seconds-first hint", () => {
    let err: unknown;
    try {
      parseCron("0 0 9 * * *");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CronError);
    expect((err as CronError).hint).toContain("seconds-first");
  });
  it("rejects the wrong field count", () => {
    expect(() => parseCron("0 9 * *")).toThrow(CronError);
    expect(() => parseCron("")).toThrow(CronError);
  });
});

describe("matching semantics", () => {
  it("ORs day-of-month and day-of-week when both are restricted", () => {
    const s = parseCron("0 0 1 * 1"); // 1st of month OR Monday
    expect(matches(local(2026, 11, 2, 0, 0), s)).toBe(true); // Mon 2 Nov, not the 1st
    expect(matches(local(2026, 11, 1, 0, 0), s)).toBe(true); // 1 Nov is a Sunday, is the 1st
    expect(matches(local(2026, 11, 3, 0, 0), s)).toBe(false); // Tue 3 Nov, neither
  });
  it("uses only the restricted day field when the other is *", () => {
    const s = parseCron("0 0 15 * *");
    expect(matches(local(2026, 11, 15, 0, 0), s)).toBe(true);
    expect(matches(local(2026, 11, 16, 0, 0), s)).toBe(false);
  });
});

describe("nextRuns", () => {
  it("finds weekday 9am runs", () => {
    // 2026-10-26 is a Monday.
    const s = parseCron("0 9 * * 1-5");
    const runs = nextRuns(s, local(2026, 10, 26, 8, 0), 3);
    expect(runs.map((d) => `${d.getDate()}-${d.getHours()}:${d.getMinutes()}`)).toEqual([
      "26-9:0",
      "27-9:0",
      "28-9:0",
    ]);
  });
  it("anchors */15 to the hour, not to the query time", () => {
    const s = parseCron("*/15 * * * *");
    const runs = nextRuns(s, local(2026, 10, 26, 10, 7), 2);
    expect(runs.map((d) => d.getMinutes())).toEqual([15, 30]);
  });
  it("finds the next leap-day run and reports Feb 30 as never running", () => {
    const leap = nextRuns(parseCron("0 0 29 2 *"), local(2026, 1, 1), 1);
    expect(leap[0]?.getFullYear()).toBe(2028);
    expect(leap[0]?.getMonth()).toBe(1);
    expect(leap[0]?.getDate()).toBe(29);
    expect(nextRuns(parseCron("30 2 30 2 *"), local(2026, 1, 1), 3)).toEqual([]);
  });
  it("counts runs in a window", () => {
    const daily = parseCron("0 0 * * *");
    // Strictly-after semantics: Oct 26 00:00 itself is excluded, Nov 2 00:00 is
    // outside the window, so Oct 27 – Nov 1 = 6 midnights.
    expect(countRunsInWindow(daily, local(2026, 10, 26, 0, 0), 7)).toBe(6);
    const everyMin = parseCron("* * * * *");
    expect(countRunsInWindow(everyMin, local(2026, 10, 26, 0, 0), 1)).toBe(1439);
  });
});

describe("describe", () => {
  it("describes common schedules in plain English", () => {
    expect(describeSchedule(parseCron("0 9 * * 1-5"))).toBe(
      "At 09:00, on Mon, Tue, Wed, Thu, Fri.",
    );
    expect(describeSchedule(parseCron("*/15 * * * *"))).toBe("Every 15 minutes, every day.");
    expect(describeSchedule(parseCron("30 3 * * 0"))).toBe("At 03:30, on Sun.");
    expect(describeSchedule(parseCron("0 0 1 1 *"))).toBe("At 00:00, on day 1 of the month in Jan.");
  });
  it("calls out the OR trap in the description", () => {
    expect(describeSchedule(parseCron("0 0 1 * 1"))).toContain("OR");
  });
  it("explains fields individually", () => {
    const s = parseCron("30 9 * * 1-5");
    expect(fieldMeaning(s.fields[0]!)).toBe("Minute 30");
    expect(fieldMeaning(s.fields[4]!)).toBe("Mon, Tue, Wed, Thu, Fri");
  });
});

describe("detectGotchas", () => {
  it("flags the OR trap, anchoring, Sunday 7, and never-runs", () => {
    const orTrap = detectGotchas(parseCron("0 0 1 * 1"), nextRuns(parseCron("0 0 1 * 1"), local(2026, 1, 1), 1));
    expect(orTrap.some((g) => g.title.includes("OR"))).toBe(true);
    const anchored = detectGotchas(parseCron("*/15 * * * *"), nextRuns(parseCron("*/15 * * * *"), local(2026, 1, 1), 1));
    expect(anchored.some((g) => g.title.includes("anchored"))).toBe(true);
    const sunday7 = detectGotchas(parseCron("0 0 * * 7"), nextRuns(parseCron("0 0 * * 7"), local(2026, 1, 1), 1));
    expect(sunday7.some((g) => g.title.includes("7 means Sunday"))).toBe(true);
    const never = detectGotchas(parseCron("30 2 30 2 *"), []);
    expect(never.some((g) => g.level === "error" && g.title.includes("never runs"))).toBe(true);
  });
  it("always notes the missing timezone", () => {
    const gotchas = detectGotchas(parseCron("0 0 * * *"), nextRuns(parseCron("0 0 * * *"), local(2026, 1, 1), 1));
    expect(gotchas.some((g) => g.title.includes("No timezone"))).toBe(true);
  });
});
