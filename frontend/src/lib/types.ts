/* ---------- Strava API (nur die Felder, die wir nutzen) ---------- */

export interface StravaAthlete {
  id: number;
  firstname?: string;
  lastname?: string;
  weight?: number; // kg
  ftp?: number | null; // W, braucht profile:read_all
}

export interface SummaryActivity {
  id: number;
  name: string;
  type: string; // "Ride", "GravelRide", "MountainBikeRide", "VirtualRide", "Run", ...
  sport_type?: string;
  distance: number; // m
  total_elevation_gain: number; // m
  start_date_local: string;
  pr_count?: number;
  achievement_count?: number;
  average_watts?: number;
  average_speed?: number; // m/s
  suffer_score?: number | null;
}

export interface SummarySegment {
  id: number;
  name: string;
  distance: number; // m
  average_grade: number; // %
  elevation_high: number;
  elevation_low: number;
}

export interface SegmentEffort {
  id: number;
  name: string;
  moving_time: number; // s
  elapsed_time: number;
  average_watts?: number;
  device_watts?: boolean;
  pr_rank?: number | null; // 1..3
  kom_rank?: number | null; // 1..10
  segment: SummarySegment;
}

export interface BestEffort {
  name: string; // "400m", "1k", "5k", ...
  distance: number; // m
  moving_time: number; // s
  elapsed_time: number;
}

export interface DetailedActivity extends SummaryActivity {
  segment_efforts?: SegmentEffort[];
  best_efforts?: BestEffort[]; // nur bei Laeufen
  average_watts?: number;
  weighted_average_watts?: number;
  moving_time: number;
  device_watts?: boolean;
}

/** Ergebnis von GET /segments/explore */
export interface ExplorerSegment {
  id: number;
  name: string;
  distance: number; // m
  avg_grade: number; // %
  elev_difference: number; // m, immer >= 0
  climb_category: number;
  starred?: boolean;
}

export interface StreamSet {
  time?: { data: number[] };
  watts?: { data: (number | null)[] };
}

export interface DetailedSegment {
  id: number;
  name: string;
  athlete_count?: number;
  xoms?: { kom?: string; qom?: string; overall?: string };
}

/* ---------- App-Modelle ---------- */

export type Sport = "ride" | "run";

/** [Dauer in Sekunden, Wert]: Watt beim Rad, Geschwindigkeit in m/s beim Laufen */
export type CurvePoint = [number, number];

export interface SegmentEntry {
  id: string;
  name: string;
  dist: number; // m
  elev: number; // Hoehenmeter (elevation_high - elevation_low)
  time: number; // beste eigene Zeit in s
  watts: number; // Durchschnittswatt des besten Efforts
  rank: number | null; // kom_rank (1..10), sonst null
  prRank: number | null; // pr_rank (1..3), sonst null
  efforts: number; // Anzahl beobachteter Efforts
  komTime?: number | null; // KOM-Zeit in s (aus xoms)
  athleteCount?: number | null;
}

export interface HuntScore {
  score: number;
  ref: number | null; // Power-Kurve auf Segmentdauer
  headroom: number;
  reliable: boolean;
}

export type FeasibilityStatus = "kom" | "attack" | "train" | "far";

export interface Feasibility {
  status: FeasibilityStatus;
  ratio: number;
  need?: number;
  have?: number;
  gap?: number;
}

export interface CoachTarget {
  name: string;
  why: string;
  pacing: string;
  targetWatts: string;
}
