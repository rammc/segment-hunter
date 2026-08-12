import { useMemo, useState } from "react";
import { T, body, display, mono } from "../theme";
import { StravaClient } from "../lib/strava";
import {
  computeBehavior,
  fmtTargetTime,
  isWorkoutDone,
  parseTargetTime,
  planProgress,
  sanitizePlanWeeks,
  weekdayIndex,
  workoutKey,
  WEEKDAYS_DE,
} from "../lib/plan";
import type { ManualDone, PlanWorkout, TrainingPlan, WorkoutType } from "../lib/plan";
import type { CurvePoint, Sport, SummaryActivity } from "../lib/types";
import { Field } from "./Field";

const TYPE_STYLE: Record<WorkoutType, { label: string; color: string }> = {
  interval: { label: "Intervalle", color: T.red },
  tempo: { label: "Tempo", color: T.gold },
  endurance: { label: "Grundlage", color: T.teal },
  long: { label: "Lang", color: "#7E9CD8" },
  recovery: { label: "Locker", color: T.faint },
  race: { label: "Rennen", color: T.gold },
};

function readJson<V>(key: string): V | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as V) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage nicht verfuegbar
  }
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function TrainingPlanSection({
  makeClient,
  sport,
  weight,
  ftp,
  curve,
  activities,
  available,
}: {
  makeClient: () => StravaClient;
  sport: Sport;
  weight: number;
  ftp: number | null;
  curve: CurvePoint[];
  activities: SummaryActivity[];
  available: boolean;
}) {
  const planKey = `sh:plan:${sport}`;
  const doneKey = `sh:planDone:${sport}`;

  const [plan, setPlan] = useState<TrainingPlan | null>(() => readJson<TrainingPlan>(planKey));
  const [manual, setManual] = useState<ManualDone>(() => readJson<ManualDone>(doneKey) ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PlanWorkout | null>(null);
  const [armDelete, setArmDelete] = useState(false);

  const [raceDate, setRaceDate] = useState("");
  const [distanceKm, setDistanceKm] = useState("");
  const [targetTime, setTargetTime] = useState("");

  // Sport-Wechsel: App remountet die Komponente per key={sport}, dadurch
  // lesen die useState-Initializer oben automatisch den richtigen Plan.

  const today = new Date().toISOString().slice(0, 10);

  const progress = useMemo(
    () => (plan ? planProgress(plan, activities, manual, today) : null),
    [plan, activities, manual, today]
  );

  /* Kalenderwochen: Zeilen von Montag bis Sonntag ueber die Planlaufzeit */
  const calendar = useMemo(() => {
    if (!plan) return [];
    const workouts = plan.weeks.flatMap((w) => w.days).sort((a, b) => a.date.localeCompare(b.date));
    if (!workouts.length) return [];
    const byDate = new Map<string, PlanWorkout[]>();
    for (const w of workouts) {
      byDate.set(w.date, [...(byDate.get(w.date) ?? []), w]);
    }
    const firstMonday = addDays(workouts[0].date, -weekdayIndex(workouts[0].date));
    const lastDate = workouts[workouts.length - 1].date;
    const rows: Array<{ monday: string; focus: string; cells: Array<{ date: string; workouts: PlanWorkout[] }> }> = [];
    let monday = firstMonday;
    let weekIdx = 0;
    while (monday <= lastDate) {
      rows.push({
        monday,
        focus: plan.weeks[weekIdx]?.focus ?? "",
        cells: Array.from({ length: 7 }, (_, i) => {
          const date = addDays(monday, i);
          return { date, workouts: byDate.get(date) ?? [] };
        }),
      });
      monday = addDays(monday, 7);
      weekIdx += 1;
    }
    return rows;
  }, [plan]);

  async function generate() {
    setError(null);
    const km = Number(String(distanceKm).replace(",", "."));
    const targetS = parseTargetTime(targetTime);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raceDate) || raceDate <= today) {
      setError("Bitte ein Racedate in der Zukunft wählen.");
      return;
    }
    if (!(km > 0)) {
      setError("Bitte eine Streckenlänge in km angeben.");
      return;
    }
    if (!targetS) {
      setError("Zielzeit bitte als mm:ss oder h:mm:ss angeben, z. B. 45:00 oder 3:30:00.");
      return;
    }
    setBusy(true);
    try {
      const client = makeClient();
      const behavior = computeBehavior(activities, sport);
      const res = await client.trainingPlan({
        sport,
        raceDate,
        distanceKm: km,
        targetTimeS: targetS,
        weight,
        ftp,
        curve,
        behavior,
      });
      const weeks = sanitizePlanWeeks(res.weeks);
      if (!weeks.length) throw new Error("Der generierte Plan war leer. Bitte nochmal versuchen.");
      const newPlan: TrainingPlan = {
        sport,
        raceDate,
        distanceKm: km,
        targetTimeS: targetS,
        createdAt: today,
        summary: res.summary,
        weeks,
      };
      setPlan(newPlan);
      setManual({});
      writeJson(planKey, newPlan);
      writeJson(doneKey, null);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Plan konnte nicht erstellt werden.");
    } finally {
      setBusy(false);
    }
  }

  function toggleDone(w: PlanWorkout) {
    if (!plan) return;
    const key = workoutKey(w);
    const current = isWorkoutDone(w, plan.sport, activities, manual);
    const next = { ...manual, [key]: !current };
    setManual(next);
    writeJson(doneKey, next);
  }

  function deletePlan() {
    if (!armDelete) {
      setArmDelete(true);
      return;
    }
    setPlan(null);
    setManual({});
    setSelected(null);
    setArmDelete(false);
    writeJson(planKey, null);
    writeJson(doneKey, null);
  }

  if (!available) return null;

  return (
    <section
      style={{
        background: T.panel,
        border: `1px solid ${T.line}`,
        borderRadius: 12,
        padding: 18,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <h2
          style={{
            ...display,
            fontSize: 18,
            letterSpacing: 0.8,
            margin: 0,
            textTransform: "uppercase",
            color: T.dim,
          }}
        >
          Trainingsplan
        </h2>
        {plan && (
          <button
            onClick={deletePlan}
            onBlur={() => setArmDelete(false)}
            style={{
              background: armDelete ? T.red : "transparent",
              color: armDelete ? "#1A0E0B" : T.red,
              border: `1px solid ${T.red}`,
              borderRadius: 8,
              padding: "7px 14px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              ...body,
            }}
          >
            {armDelete ? "Wirklich löschen? Klick bestätigt." : "🗑 Plan löschen"}
          </button>
        )}
      </div>

      {/* Builder-Formular */}
      {!plan && (
        <>
          <p style={{ color: T.dim, fontSize: 14, margin: "0 0 12px", lineHeight: 1.5 }}>
            Racedate, Strecke und Zielzeit angeben. Der Plan baut auf deinem Trainingsverhalten
            der letzten 8 Wochen auf (Einheiten pro Woche, Umfang, typische Trainingstage) und
            deiner {sport === "ride" ? "Power" : "Pace"}-Kurve.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <label style={{ display: "block", flex: "1 1 170px" }}>
              <span
                style={{
                  color: T.faint,
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Racedate
              </span>
              <input
                type="date"
                value={raceDate}
                min={addDays(today, 1)}
                onChange={(e) => setRaceDate(e.target.value)}
                style={{
                  ...mono,
                  width: "100%",
                  boxSizing: "border-box",
                  background: T.bg,
                  color: T.text,
                  border: `1px solid ${T.line}`,
                  borderRadius: 8,
                  padding: "10px 12px",
                  fontSize: 13,
                  colorScheme: "dark",
                }}
              />
            </label>
            <Field
              label="Strecke (km)"
              value={distanceKm}
              onChange={setDistanceKm}
              placeholder={sport === "ride" ? "z. B. 120" : "z. B. 10"}
              flex="1 1 130px"
            />
            <Field
              label="Zielzeit"
              value={targetTime}
              onChange={setTargetTime}
              placeholder={sport === "ride" ? "z. B. 3:30:00" : "z. B. 45:00"}
              flex="1 1 150px"
            />
          </div>
          <button
            onClick={generate}
            disabled={busy}
            style={{
              ...display,
              background: busy ? T.line : T.gold,
              color: busy ? T.faint : "#1A1608",
              border: "none",
              borderRadius: 8,
              padding: "10px 22px",
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: 0.5,
              cursor: busy ? "wait" : "pointer",
              textTransform: "uppercase",
            }}
          >
            {busy ? "Erstelle Plan …" : "Plan erstellen"}
          </button>
          {busy && (
            <span style={{ marginLeft: 12, color: T.dim, fontSize: 13 }}>
              Der Coach plant deine Wochen, das dauert etwa eine halbe Minute …
            </span>
          )}
        </>
      )}

      {error && <p style={{ color: T.red, margin: "10px 0 0" }}>{error}</p>}

      {/* Plan-Ansicht */}
      {plan && progress && (
        <>
          <p style={{ color: T.dim, fontSize: 14, margin: "0 0 6px", lineHeight: 1.5 }}>
            <span style={{ color: T.gold, fontWeight: 600 }}>
              {plan.distanceKm} km am {plan.raceDate}, Ziel {fmtTargetTime(plan.targetTimeS)}
            </span>
            {" · "}
            {plan.summary}
          </p>

          {/* Progress */}
          <div style={{ margin: "10px 0 14px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12,
                color: T.dim,
                marginBottom: 4,
              }}
            >
              <span>
                {progress.doneDue} von {progress.due} fälligen Einheiten absolviert
                {progress.due > 0 ? ` (${progress.pct} %)` : ""}
              </span>
              <span>{progress.total} Einheiten gesamt</span>
            </div>
            <div style={{ background: T.line, borderRadius: 999, height: 8, overflow: "hidden" }}>
              <div
                style={{
                  width: `${progress.pct}%`,
                  background: progress.pct >= 80 ? T.gold : T.teal,
                  height: "100%",
                  borderRadius: 999,
                  transition: "width 0.3s",
                }}
              />
            </div>
          </div>

          {/* Kalender */}
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 640 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "90px repeat(7, 1fr)",
                  gap: 4,
                  marginBottom: 4,
                }}
              >
                <span />
                {WEEKDAYS_DE.map((d) => (
                  <span
                    key={d}
                    style={{
                      color: T.faint,
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: 0.8,
                      textAlign: "center",
                    }}
                  >
                    {d}
                  </span>
                ))}
              </div>
              {calendar.map((row, i) => (
                <div
                  key={row.monday}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "90px repeat(7, 1fr)",
                    gap: 4,
                    marginBottom: 4,
                  }}
                >
                  <div style={{ color: T.faint, fontSize: 11, paddingTop: 8, lineHeight: 1.4 }}>
                    <div style={{ ...mono }}>W{i + 1}</div>
                    {row.focus && <div>{row.focus}</div>}
                  </div>
                  {row.cells.map((cell) => {
                    const isToday = cell.date === today;
                    const isPast = cell.date < today;
                    return (
                      <div
                        key={cell.date}
                        style={{
                          background: T.bg,
                          border: `1px solid ${isToday ? T.gold : T.line}`,
                          borderRadius: 8,
                          padding: 6,
                          minHeight: 52,
                          opacity: isPast && !cell.workouts.length ? 0.5 : 1,
                        }}
                      >
                        <div style={{ ...mono, color: T.faint, fontSize: 10, marginBottom: 4 }}>
                          {Number(cell.date.slice(8, 10))}.{Number(cell.date.slice(5, 7))}.
                        </div>
                        {cell.workouts.map((w) => {
                          const done = isWorkoutDone(w, plan.sport, activities, manual);
                          const st = TYPE_STYLE[w.type];
                          const isSel = selected && workoutKey(selected) === workoutKey(w);
                          return (
                            <button
                              key={workoutKey(w)}
                              onClick={() => setSelected(isSel ? null : w)}
                              title={w.title}
                              style={{
                                ...body,
                                display: "block",
                                width: "100%",
                                textAlign: "left",
                                background: w.type === "race" ? T.gold : st.color + "26",
                                color: w.type === "race" ? "#1A1608" : st.color,
                                border: `1px solid ${isSel ? T.text : st.color + "66"}`,
                                borderRadius: 6,
                                padding: "3px 6px",
                                fontSize: 11.5,
                                fontWeight: 600,
                                cursor: "pointer",
                                marginBottom: 3,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                textDecoration: done && w.type !== "race" ? "line-through" : "none",
                              }}
                            >
                              {done ? "✓ " : ""}
                              {w.title}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Legende */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: "8px 0 0" }}>
            {(Object.keys(TYPE_STYLE) as WorkoutType[]).map((t) => (
              <span key={t} style={{ color: TYPE_STYLE[t].color, fontSize: 12 }}>
                ● {TYPE_STYLE[t].label}
              </span>
            ))}
          </div>

          {/* Detail-Panel */}
          {selected && (
            <div
              style={{
                background: T.bg,
                border: `1px solid ${T.line}`,
                borderRadius: 10,
                padding: 14,
                marginTop: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 15 }}>
                  <span style={{ color: TYPE_STYLE[selected.type].color }}>
                    {TYPE_STYLE[selected.type].label}
                  </span>{" "}
                  · {selected.title}
                  <span style={{ ...mono, color: T.dim, fontSize: 13, marginLeft: 10 }}>
                    {selected.date} · {selected.durationMin} min
                    {selected.target ? ` · ${selected.target}` : ""}
                  </span>
                </div>
                {selected.type !== "race" && (
                  <button
                    onClick={() => toggleDone(selected)}
                    style={{
                      background: "transparent",
                      color: isWorkoutDone(selected, plan.sport, activities, manual)
                        ? T.teal
                        : T.gold,
                      border: `1px solid ${
                        isWorkoutDone(selected, plan.sport, activities, manual) ? T.teal : T.gold
                      }`,
                      borderRadius: 8,
                      padding: "6px 12px",
                      fontSize: 13,
                      cursor: "pointer",
                      ...body,
                    }}
                  >
                    {isWorkoutDone(selected, plan.sport, activities, manual)
                      ? "✓ Erledigt (zurücksetzen)"
                      : "Als erledigt markieren"}
                  </button>
                )}
              </div>
              <p style={{ color: T.dim, fontSize: 14, margin: "8px 0 0", lineHeight: 1.5 }}>
                {selected.description}
              </p>
            </div>
          )}

          <p style={{ color: T.faint, fontSize: 12, margin: "10px 0 0", lineHeight: 1.5 }}>
            Einheiten werden automatisch abgehakt, wenn an dem Tag eine passende{" "}
            {plan.sport === "ride" ? "Fahrt" : "Lauf"}-Aktivität mit mindestens der halben
            geplanten Dauer auf Strava liegt ("Aktualisieren" lädt neue Aktivitäten). Manuelles
            Abhaken übersteuert das. Plan und Fortschritt liegen nur in diesem Browser.
          </p>
        </>
      )}
    </section>
  );
}
