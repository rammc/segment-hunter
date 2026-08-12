import type { Sport, SummaryActivity } from "./types";

/* ============================================================
   Trainingsplan: Typen, Verhaltensanalyse und Progress-Matching.
   Der Plan selbst wird serverseitig generiert (POST /trainingplan),
   hier lebt alles, was deterministisch und testbar ist.
   ============================================================ */

export type WorkoutType = "interval" | "tempo" | "endurance" | "long" | "recovery" | "race";

export interface PlanWorkout {
  date: string; // YYYY-MM-DD
  type: WorkoutType;
  title: string;
  description: string;
  durationMin: number;
  target?: string; // z. B. "290 W" oder "4:45 /km"
}

export interface PlanWeek {
  focus: string;
  days: PlanWorkout[];
}

export interface TrainingPlan {
  sport: Sport;
  raceDate: string;
  distanceKm: number;
  targetTimeS: number;
  createdAt: string;
  summary: string;
  weeks: PlanWeek[];
}

export const SPORT_ACTIVITY_TYPES: Record<Sport, Set<string>> = {
  ride: new Set(["Ride", "GravelRide", "MountainBikeRide", "VirtualRide"]),
  run: new Set(["Run", "TrailRun"]),
};

export const WEEKDAYS_DE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

/** Wochentag-Index Mo=0..So=6 aus YYYY-MM-DD */
export function weekdayIndex(date: string): number {
  const d = new Date(`${date}T12:00:00`);
  return (d.getDay() + 6) % 7;
}

/** "45:00" -> 2700 s, "3:30:00" -> 12600 s, "45" -> 2700 s (Minuten) */
export function parseTargetTime(str: string | null | undefined): number | null {
  if (!str) return null;
  const parts = String(str).trim().split(":").map(Number);
  if (!parts.length || parts.some((p) => isNaN(p) || p < 0)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 60;
}

export function fmtTargetTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.round(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/* ---------- Trainingsverhalten aus den letzten Wochen ---------- */

export interface TrainingBehavior {
  weeksAnalyzed: number;
  sessionsPerWeek: number;
  hoursPerWeek: number;
  weeklyKm: number;
  longestSessionMin: number;
  typicalDays: string[]; // z. B. ["Di", "Do", "Sa"]
}

const BEHAVIOR_WINDOW_DAYS = 56; // 8 Wochen

export function computeBehavior(
  activities: SummaryActivity[],
  sport: Sport,
  today: Date = new Date()
): TrainingBehavior {
  const types = SPORT_ACTIVITY_TYPES[sport];
  const cutoff = today.getTime() - BEHAVIOR_WINDOW_DAYS * 24 * 3600 * 1000;
  const relevant = activities.filter((a) => {
    if (!(types.has(a.type) || types.has(a.sport_type ?? ""))) return false;
    const t = new Date(a.start_date_local).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  const weeks = BEHAVIOR_WINDOW_DAYS / 7;
  const totalSec = relevant.reduce((sum, a) => sum + (a.moving_time ?? 0), 0);
  const totalKm = relevant.reduce((sum, a) => sum + a.distance / 1000, 0);
  const longest = relevant.reduce((max, a) => Math.max(max, a.moving_time ?? 0), 0);

  const dayCounts = new Map<number, number>();
  for (const a of relevant) {
    const idx = weekdayIndex(a.start_date_local.slice(0, 10));
    dayCounts.set(idx, (dayCounts.get(idx) ?? 0) + 1);
  }
  const typicalDays = [...dayCounts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([idx]) => WEEKDAYS_DE[idx]);

  return {
    weeksAnalyzed: weeks,
    sessionsPerWeek: Math.round((relevant.length / weeks) * 10) / 10,
    hoursPerWeek: Math.round((totalSec / 3600 / weeks) * 10) / 10,
    weeklyKm: Math.round((totalKm / weeks) * 10) / 10,
    longestSessionMin: Math.round(longest / 60),
    typicalDays,
  };
}

/* ---------- Progress-Tracking ---------- */

export type ManualDone = Record<string, boolean>; // key: workoutKey

export function workoutKey(w: Pick<PlanWorkout, "date" | "title">): string {
  return `${w.date}|${w.title}`;
}

/**
 * Eine geplante Einheit gilt als absolviert, wenn am selben Tag eine passende
 * Aktivitaet der Sportart existiert, die mindestens die halbe geplante Dauer
 * hat. Manuelles Abhaken ueberschreibt das Matching in beide Richtungen.
 */
export function isWorkoutDone(
  w: PlanWorkout,
  sport: Sport,
  activities: SummaryActivity[],
  manual: ManualDone
): boolean {
  const manualState = manual[workoutKey(w)];
  if (manualState !== undefined) return manualState;
  const types = SPORT_ACTIVITY_TYPES[sport];
  return activities.some(
    (a) =>
      (types.has(a.type) || types.has(a.sport_type ?? "")) &&
      a.start_date_local.slice(0, 10) === w.date &&
      (a.moving_time ?? 0) >= w.durationMin * 60 * 0.5
  );
}

export interface PlanProgress {
  total: number;
  due: number; // Einheiten mit Datum bis heute
  doneDue: number; // davon absolviert
  pct: number; // doneDue / due
}

export function planProgress(
  plan: TrainingPlan,
  activities: SummaryActivity[],
  manual: ManualDone,
  today: string = new Date().toISOString().slice(0, 10)
): PlanProgress {
  const workouts = plan.weeks.flatMap((w) => w.days);
  const due = workouts.filter((w) => w.date <= today);
  const doneDue = due.filter((w) => isWorkoutDone(w, plan.sport, activities, manual));
  return {
    total: workouts.length,
    due: due.length,
    doneDue: doneDue.length,
    pct: due.length ? Math.round((doneDue.length / due.length) * 100) : 0,
  };
}

/* ---------- Plan-Validierung (Antwort der Worker-Route) ---------- */

const WORKOUT_TYPES = new Set<string>(["interval", "tempo", "endurance", "long", "recovery", "race"]);

export function sanitizePlanWeeks(raw: unknown): PlanWeek[] {
  if (!Array.isArray(raw)) return [];
  const weeks: PlanWeek[] = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const days = Array.isArray((w as { days?: unknown }).days)
      ? ((w as { days: unknown[] }).days
          .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object")
          .map((d) => ({
            date: String(d.date ?? ""),
            type: (WORKOUT_TYPES.has(String(d.type)) ? String(d.type) : "endurance") as WorkoutType,
            title: String(d.title ?? "Training"),
            description: String(d.description ?? ""),
            durationMin: Math.max(0, Math.round(Number(d.durationMin) || 0)),
            target: d.target ? String(d.target) : undefined,
          }))
          .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)) as PlanWorkout[])
      : [];
    if (days.length) {
      weeks.push({ focus: String((w as { focus?: unknown }).focus ?? ""), days });
    }
  }
  return weeks;
}
