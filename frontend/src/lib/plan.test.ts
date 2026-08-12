import { describe, expect, it } from "vitest";
import {
  computeBehavior,
  fmtTargetTime,
  isWorkoutDone,
  parseTargetTime,
  planProgress,
  sanitizePlanWeeks,
  weekdayIndex,
} from "./plan";
import type { PlanWorkout, TrainingPlan } from "./plan";
import type { SummaryActivity } from "./types";

function act(overrides: Partial<SummaryActivity>): SummaryActivity {
  return {
    id: Math.random(),
    name: "Test",
    type: "Ride",
    distance: 30000,
    total_elevation_gain: 100,
    moving_time: 3600,
    start_date_local: "2026-08-10T08:00:00Z",
    ...overrides,
  };
}

describe("parseTargetTime", () => {
  it("parst mm:ss, h:mm:ss und blanke Minuten", () => {
    expect(parseTargetTime("45:00")).toBe(2700);
    expect(parseTargetTime("3:30:00")).toBe(12600);
    expect(parseTargetTime("45")).toBe(2700);
  });
  it("gibt null fuer Unsinn", () => {
    expect(parseTargetTime("abc")).toBeNull();
    expect(parseTargetTime("")).toBeNull();
    expect(parseTargetTime("-5:00")).toBeNull();
  });
});

describe("fmtTargetTime", () => {
  it("formatiert Sekunden lesbar", () => {
    expect(fmtTargetTime(2700)).toBe("45:00");
    expect(fmtTargetTime(12600)).toBe("3:30:00");
  });
});

describe("weekdayIndex", () => {
  it("liefert Mo=0 bis So=6", () => {
    expect(weekdayIndex("2026-08-10")).toBe(0); // Montag
    expect(weekdayIndex("2026-08-16")).toBe(6); // Sonntag
  });
});

describe("computeBehavior", () => {
  const today = new Date("2026-08-12T12:00:00");

  it("teilt durch die tatsaechlich abgedeckte Zeitspanne und erkennt typische Tage", () => {
    // Daten decken nur ~2 Wochen ab: Divisor muss ~2, nicht 8 sein
    const behavior = computeBehavior(
      [
        act({ start_date_local: "2026-08-11T08:00:00Z" }), // Di
        act({ start_date_local: "2026-08-04T08:00:00Z" }), // Di
        act({ start_date_local: "2026-08-08T08:00:00Z" }), // Sa
        act({ start_date_local: "2026-08-01T08:00:00Z" }), // Sa
        act({ start_date_local: "2026-07-28T08:00:00Z" }), // Di
      ],
      "ride",
      today
    );
    expect(behavior.weeksAnalyzed).toBeGreaterThanOrEqual(2);
    expect(behavior.weeksAnalyzed).toBeLessThanOrEqual(2.5);
    expect(behavior.sessionsPerWeek).toBeGreaterThan(1.9);
    expect(behavior.sessionsPerWeek).toBeLessThan(2.7);
    expect(behavior.typicalDays).toContain("Di");
    expect(behavior.typicalDays).toContain("Sa");
    expect(behavior.longestSessionMin).toBe(60);
  });

  it("liefert den echten Wochenumfang bei vollen 8 Wochen Daten (80 km/Woche)", () => {
    // 8 Wochen, 4 Laeufe pro Woche a 20 km
    const acts: SummaryActivity[] = [];
    for (let w = 0; w < 8; w++) {
      for (const dayOffset of [0, 2, 4, 5]) {
        const d = new Date("2026-08-10T08:00:00"); // Montag der juengsten Woche
        d.setDate(d.getDate() - w * 7 + dayOffset - 5);
        acts.push(
          act({
            type: "Run",
            distance: 20000,
            moving_time: 6000,
            start_date_local: d.toISOString(),
          })
        );
      }
    }
    const behavior = computeBehavior(acts, "run", today);
    expect(behavior.weeklyKm).toBeGreaterThan(70);
    expect(behavior.weeklyKm).toBeLessThan(90);
    expect(behavior.sessionsPerWeek).toBeGreaterThan(3.4);
  });

  it("ignoriert andere Sportarten und alte Aktivitaeten", () => {
    const behavior = computeBehavior(
      [
        act({ type: "Run", start_date_local: "2026-08-11T08:00:00Z" }),
        act({ start_date_local: "2025-01-01T08:00:00Z" }),
      ],
      "ride",
      today
    );
    expect(behavior.sessionsPerWeek).toBe(0);
    expect(behavior.typicalDays).toEqual([]);
  });
});

describe("isWorkoutDone / planProgress", () => {
  const workout: PlanWorkout = {
    date: "2026-08-11",
    type: "endurance",
    title: "GA1",
    description: "",
    durationMin: 60,
  };

  it("matcht eine passende Aktivitaet am selben Tag", () => {
    const done = isWorkoutDone(
      workout,
      "ride",
      [act({ start_date_local: "2026-08-11T17:00:00Z", moving_time: 3000 })],
      {}
    );
    expect(done).toBe(true);
  });

  it("matcht nicht bei zu kurzer Aktivitaet, falschem Tag oder falscher Sportart", () => {
    expect(
      isWorkoutDone(workout, "ride", [act({ start_date_local: "2026-08-11T17:00:00Z", moving_time: 900 })], {})
    ).toBe(false);
    expect(
      isWorkoutDone(workout, "ride", [act({ start_date_local: "2026-08-12T17:00:00Z" })], {})
    ).toBe(false);
    expect(
      isWorkoutDone(workout, "ride", [act({ type: "Run", start_date_local: "2026-08-11T17:00:00Z" })], {})
    ).toBe(false);
  });

  it("manuelles Abhaken uebersteuert in beide Richtungen", () => {
    expect(isWorkoutDone(workout, "ride", [], { "2026-08-11|GA1": true })).toBe(true);
    expect(
      isWorkoutDone(
        workout,
        "ride",
        [act({ start_date_local: "2026-08-11T17:00:00Z" })],
        { "2026-08-11|GA1": false }
      )
    ).toBe(false);
  });

  it("planProgress zaehlt nur faellige Einheiten", () => {
    const plan: TrainingPlan = {
      sport: "ride",
      raceDate: "2026-09-01",
      distanceKm: 100,
      targetTimeS: 12600,
      createdAt: "2026-08-01",
      summary: "",
      weeks: [
        {
          focus: "Aufbau",
          days: [
            { ...workout, date: "2026-08-10" },
            { ...workout, date: "2026-08-11", title: "Intervalle" },
            { ...workout, date: "2026-08-20", title: "Zukunft" },
          ],
        },
      ],
    };
    const p = planProgress(
      plan,
      [act({ start_date_local: "2026-08-10T08:00:00Z" })],
      {},
      "2026-08-12"
    );
    expect(p.total).toBe(3);
    expect(p.due).toBe(2);
    expect(p.doneDue).toBe(1);
    expect(p.pct).toBe(50);
  });
});

describe("sanitizePlanWeeks", () => {
  it("uebernimmt valide Wochen und verwirft Muell", () => {
    const weeks = sanitizePlanWeeks([
      {
        focus: "Aufbau",
        days: [
          { date: "2026-08-14", type: "interval", title: "4x4", description: "hart", durationMin: 60, target: "300 W" },
          { date: "kein-datum", type: "interval", title: "kaputt", description: "", durationMin: 60 },
        ],
      },
      { focus: "leer", days: [] },
      "unsinn",
    ]);
    expect(weeks.length).toBe(1);
    expect(weeks[0].days.length).toBe(1);
    expect(weeks[0].days[0].title).toBe("4x4");
  });

  it("faellt bei unbekanntem Typ auf endurance zurueck", () => {
    const weeks = sanitizePlanWeeks([
      { focus: "", days: [{ date: "2026-08-14", type: "yoga", title: "x", description: "", durationMin: 30 }] },
    ]);
    expect(weeks[0].days[0].type).toBe("endurance");
  });
});
