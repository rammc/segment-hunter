import type { CurvePoint, Feasibility, HuntScore, SegmentEntry } from "./types";

/* ============================================================
   Fachlogik (aus dem Prototyp extrahiert)
   - curveAt: log-Interpolation auf der Power-Kurve
   - huntScore: 70 % Leistungsreserve + 30 % Rang-Bonus
   - komFeasibility: benoetigte Watt fuer die KOM-Zeit ueber ein
     Steigungsmodell, verglichen mit der Power-Kurve
   - buildPowerCurve / maxAvgPower: Power-Kurve aus Watt-Streams
     (Sliding Window) plus Effort-Punkten als Fallback
   ============================================================ */

/** Unplausible Efforts nicht scoren */
export const MIN_RELIABLE_WATTS = 30;
export const MIN_RELIABLE_TIME = 30;

/**
 * Kurve an einer Dauer auslesen, ohne Rundung (log-Interpolation zwischen
 * Stuetzstellen). Fuer Pace-Kurven (m/s) wichtig, wo Rundung alles zerstoert.
 */
export function interpolateAt(curve: CurvePoint[], sec: number): number | null {
  if (!curve.length) return null;
  const sorted = [...curve].sort((a, b) => a[0] - b[0]);
  if (sec <= sorted[0][0]) return sorted[0][1];
  if (sec >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [t1, w1] = sorted[i];
    const [t2, w2] = sorted[i + 1];
    if (sec >= t1 && sec <= t2) {
      const f = (Math.log(sec) - Math.log(t1)) / (Math.log(t2) - Math.log(t1));
      return w1 + f * (w2 - w1);
    }
  }
  return null;
}

/** Power-Kurve an einer Dauer auslesen (gerundet, fuer Watt) */
export function curveAt(curve: CurvePoint[], sec: number): number | null {
  const v = interpolateAt(curve, sec);
  return v === null ? null : Math.round(v);
}

/** "5:31", "1:02:11" oder "45s" -> Sekunden */
export function parseKomTime(str: string | null | undefined): number | null {
  if (!str) return null;
  const s = String(str).trim().replace("s", "");
  const parts = s.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

/**
 * Benoetigte Watt fuer die KOM-Zeit, geschaetzt ueber ein Steigungsmodell:
 * P proportional v bei Steigung >= 5 %, v^2.7 im Flachen (<= 1 %),
 * dazwischen linear geblendet. Wind, Aero-Position und Taktik sind
 * nicht modelliert.
 */
export function requiredWattsForKom(
  seg: Pick<SegmentEntry, "watts" | "time" | "dist" | "elev">,
  komTime: number | null
): number | null {
  if (!seg.watts || seg.watts < MIN_RELIABLE_WATTS || !komTime || komTime >= seg.time) return null;
  const grade = seg.dist > 0 ? (seg.elev / seg.dist) * 100 : 0;
  const k = grade >= 5 ? 1.05 : grade <= 1 ? 2.7 : 2.7 - ((grade - 1) / 4) * (2.7 - 1.05);
  return Math.round(seg.watts * Math.pow(seg.time / komTime, k));
}

/**
 * Hunt-Score: 70 % Leistungsreserve auf der Segmentdauer (gedeckelt bei 60 %),
 * 30 % Rang-Bonus. Ohne bekannten Rang gibt es einen neutralen Bonus von 0.3.
 */
export function huntScore(
  seg: Pick<SegmentEntry, "time" | "watts" | "rank">,
  curve: CurvePoint[]
): HuntScore {
  const ref = curveAt(curve, seg.time);
  let headroom = 0;
  if (ref && seg.watts > MIN_RELIABLE_WATTS) headroom = Math.max(0, (ref - seg.watts) / ref);
  const rankBonus =
    seg.rank != null ? Math.max(0, Math.min(1, (60 - seg.rank) / 60)) : 0.3;
  const reliable = seg.watts > MIN_RELIABLE_WATTS && seg.time >= MIN_RELIABLE_TIME;
  const raw = 100 * ((0.7 * Math.min(headroom, 0.6)) / 0.6 + 0.3 * rankBonus);
  return { score: Math.round(raw), ref, headroom, reliable };
}

/**
 * KOM-Machbarkeit: Power-Kurve auf der KOM-Dauer geteilt durch benoetigte Watt.
 * Badges: kom (gehalten), attack (>= 0.97), train (0.85 bis 0.97), far (darunter).
 */
export function komFeasibility(
  seg: Pick<SegmentEntry, "komTime" | "time" | "watts" | "dist" | "elev">,
  curve: CurvePoint[]
): Feasibility | null {
  if (!seg.komTime) return null;
  if (seg.komTime >= seg.time) return { status: "kom", ratio: 1 };
  const need = requiredWattsForKom(seg, seg.komTime);
  const have = curveAt(curve, seg.komTime);
  if (!need || !have) return null;
  const ratio = have / need;
  const status = ratio >= 0.97 ? "attack" : ratio >= 0.85 ? "train" : "far";
  return { status, ratio, need, have, gap: seg.time - seg.komTime };
}

export function fmtTime(s: number | null | undefined): string {
  if (s == null) return "-";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.round(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return m > 0 ? `${m}:${String(r).padStart(2, "0")} min` : `${r} s`;
}

/* ---------- Power-Kurve aus Streams und Efforts ---------- */

/** Standard-Stuetzstellen der Power-Kurve */
export const CURVE_DURATIONS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];

/** Aufzeichnungsluecken (Auto-Pause) nicht als Fahrzeit werten */
const MAX_SAMPLE_GAP = 10;

/**
 * Beste Durchschnittsleistung ueber ein Zeitfenster (Sliding Window ueber
 * den Watt-Stream, zeitgewichtet). Gibt null zurueck, wenn die Aktivitaet
 * kuerzer als das Fenster ist.
 */
export function maxAvgPower(
  time: number[],
  watts: (number | null)[],
  windowSec: number
): number | null {
  const n = Math.min(time.length, watts.length);
  if (n < 2 || windowSec <= 0) return null;

  // dt[k] = Dauer, die Sample k repraesentiert (gedeckelt gegen Luecken)
  const dt: number[] = new Array(n).fill(0);
  for (let k = 1; k < n; k++) {
    dt[k] = Math.min(Math.max(time[k] - time[k - 1], 0), MAX_SAMPLE_GAP);
  }

  let best: number | null = null;
  let i = 0; // Fenster umfasst Samples (i, j]
  let dur = 0;
  let sum = 0;
  for (let j = 1; j < n; j++) {
    dur += dt[j];
    sum += (watts[j] ?? 0) * dt[j];
    // Fenster von vorne verkleinern, solange es noch >= windowSec bleibt
    while (i + 1 < j && dur - dt[i + 1] >= windowSec) {
      i++;
      dur -= dt[i];
      sum -= (watts[i] ?? 0) * dt[i];
    }
    if (dur >= windowSec && dur > 0) {
      const avg = sum / dur;
      if (best === null || avg > best) best = avg;
    }
  }
  return best === null ? null : Math.round(best);
}

export interface StreamInput {
  time: number[];
  watts: (number | null)[];
}

/**
 * Power-Kurve aus mehreren Aktivitaeten:
 * 1. pro Standard-Dauer die beste Durchschnittsleistung aus allen Watt-Streams
 * 2. Effort-Punkte [Dauer, Watt] als zusaetzliche Untergrenzen (Fallback,
 *    wenn kein Powermeter-Stream vorhanden ist)
 * 3. Monotonie erzwingen: kuerzere Dauer darf nie weniger Watt haben
 */
export function buildPowerCurve(
  streams: StreamInput[],
  effortPoints: CurvePoint[] = []
): CurvePoint[] {
  const byDuration = new Map<number, number>();
  const bump = (sec: number, w: number) => {
    if (!Number.isFinite(sec) || !Number.isFinite(w) || sec <= 0 || w <= 0) return;
    const prev = byDuration.get(sec);
    if (prev === undefined || w > prev) byDuration.set(sec, w);
  };

  for (const s of streams) {
    for (const d of CURVE_DURATIONS) {
      const w = maxAvgPower(s.time, s.watts, d);
      if (w !== null) bump(d, w);
    }
  }
  for (const [sec, w] of effortPoints) {
    bump(Math.round(sec), Math.round(w));
  }

  const points = [...byDuration.entries()].sort((a, b) => a[0] - b[0]);
  // Monotonie: von der laengsten zur kuerzesten Dauer das Maximum nach vorne tragen
  for (let k = points.length - 2; k >= 0; k--) {
    if (points[k][1] < points[k + 1][1]) points[k][1] = points[k + 1][1];
  }
  return points as CurvePoint[];
}

/**
 * FTP aus dem Strava-Profil als Kurven-Stuetzstellen: FTP entspricht etwa der
 * Stundenleistung, die 20-Minuten-Leistung liegt bei etwa FTP / 0.95. Das
 * verankert die Kurve in dem Dauerbereich, in dem die meisten KOM-Zeiten
 * liegen, auch wenn die analysierten Fahrten locker waren.
 */
export function ftpCurvePoints(ftp: number | null | undefined): CurvePoint[] {
  if (!ftp || !Number.isFinite(ftp) || ftp < 50 || ftp > 600) return [];
  return [
    [1200, Math.round(ftp / 0.95)],
    [3600, Math.round(ftp)],
  ];
}

/* ---------- Laufen: Pace-Kurve aus Best Efforts ---------- */

/** Mindestdistanz, ab der ein Lauf-Effort als aussagekraeftig gilt */
export const MIN_RUN_EFFORT_DIST = 200;

/**
 * Pace-Kurve [Dauer s, Geschwindigkeit m/s] aus Best Efforts (400 m, 1 km, ...)
 * und Segment-Efforts. Gleiche Envelope- und Monotonie-Logik wie die
 * Power-Kurve: kuerzere Dauer darf nie langsamer sein als laengere.
 */
export function buildSpeedCurve(
  efforts: Array<{ distance: number; moving_time: number }>
): CurvePoint[] {
  const byDuration = new Map<number, number>();
  for (const e of efforts) {
    if (!e || !Number.isFinite(e.distance) || !Number.isFinite(e.moving_time)) continue;
    if (e.moving_time < MIN_RELIABLE_TIME || e.distance < MIN_RUN_EFFORT_DIST) continue;
    const sec = Math.round(e.moving_time);
    const speed = e.distance / e.moving_time;
    const prev = byDuration.get(sec);
    if (prev === undefined || speed > prev) byDuration.set(sec, speed);
  }
  const points = [...byDuration.entries()].sort((a, b) => a[0] - b[0]);
  for (let k = points.length - 2; k >= 0; k--) {
    if (points[k][1] < points[k + 1][1]) points[k][1] = points[k + 1][1];
  }
  return points as CurvePoint[];
}

/**
 * Hunt-Score fuer Laufsegmente: Reserve = Abstand deiner Effort-Geschwindigkeit
 * zur Pace-Kurve auf der Segmentdauer, gleiche Gewichtung wie beim Rad.
 */
export function runHuntScore(
  seg: Pick<SegmentEntry, "time" | "dist" | "rank">,
  speedCurve: CurvePoint[]
): HuntScore {
  const refSpeed = interpolateAt(speedCurve, seg.time);
  const ownSpeed = seg.time > 0 ? seg.dist / seg.time : 0;
  let headroom = 0;
  if (refSpeed && ownSpeed > 0) headroom = Math.max(0, (refSpeed - ownSpeed) / refSpeed);
  const rankBonus =
    seg.rank != null ? Math.max(0, Math.min(1, (60 - seg.rank) / 60)) : 0.3;
  const reliable = seg.time >= MIN_RELIABLE_TIME && seg.dist >= MIN_RUN_EFFORT_DIST;
  const raw = 100 * ((0.7 * Math.min(headroom, 0.6)) / 0.6 + 0.3 * rankBonus);
  return { score: Math.round(raw), ref: refSpeed, headroom, reliable };
}

/**
 * CR-Machbarkeit fuer Laufsegmente: benoetigte Geschwindigkeit (Distanz durch
 * CR-Zeit) gegen die Pace-Kurve auf der CR-Dauer. Steigung ist beim Laufen
 * nicht modelliert. need/have sind m/s.
 */
export function runFeasibility(
  seg: Pick<SegmentEntry, "komTime" | "time" | "dist">,
  speedCurve: CurvePoint[]
): Feasibility | null {
  if (!seg.komTime || seg.komTime <= 0 || seg.dist <= 0) return null;
  if (seg.time > 0 && seg.komTime >= seg.time) return { status: "kom", ratio: 1 };
  const need = seg.dist / seg.komTime;
  const have = interpolateAt(speedCurve, seg.komTime);
  if (!have) return null;
  const ratio = have / need;
  const status = ratio >= 0.97 ? "attack" : ratio >= 0.85 ? "train" : "far";
  return { status, ratio, need, have, gap: seg.time > 0 ? seg.time - seg.komTime : undefined };
}

/** m/s -> "4:32 /km" */
export function fmtPace(speed: number | null | undefined): string {
  if (!speed || speed <= 0) return "-";
  const secPerKm = 1000 / speed;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  if (s === 60) return `${m + 1}:00 /km`;
  return `${m}:${String(s).padStart(2, "0")} /km`;
}

/* ---------- Physikmodell fuer nie gefahrene Segmente (Explore) ---------- */

const GRAVITY = 9.81;
const CRR = 0.005; // Rollwiderstand Rennrad/Asphalt
const CDA = 0.35; // Aero-Flaeche Unterlenker/Haenden am Bremsgriff
const RHO = 1.226; // Luftdichte auf Meereshoehe
const BIKE_KG = 9;
const DRIVETRAIN_EFF = 0.976;

/**
 * Benoetigte Watt, um ein Segment in einer Zielzeit zu fahren, ohne eigenen
 * Referenz-Effort: P = (Roll + Steigung) * v + Luftwiderstand * v^3.
 * Wind und Kurven sind nicht modelliert; bei Gefaelle-Segmenten (negativ
 * berechnete Leistung) gibt es null zurueck.
 */
export function physicsKomWatts(
  distM: number,
  elevDiffM: number,
  komTimeS: number,
  weightKg: number
): number | null {
  if (!distM || !komTimeS || distM <= 0 || komTimeS <= 0 || weightKg <= 0) return null;
  const v = distM / komTimeS;
  const m = weightKg + BIKE_KG;
  const grade = elevDiffM / distM; // elev_difference ist bei Strava >= 0, safe
  const rolling = CRR * m * GRAVITY * v;
  const climbing = m * GRAVITY * grade * v;
  const aero = 0.5 * RHO * CDA * Math.pow(v, 3);
  const watts = (rolling + climbing + aero) / DRIVETRAIN_EFF;
  if (!Number.isFinite(watts) || watts <= 0) return null;
  return Math.round(watts);
}
