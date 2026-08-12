import type {
  CoachTarget,
  CurvePoint,
  DetailedActivity,
  DetailedSegment,
  ExplorerSegment,
  StravaAthlete,
  StreamSet,
  SummaryActivity,
} from "./types";

/* ============================================================
   Worker-Client: alle Strava-Daten laufen ueber den eigenen
   Cloudflare Worker (worker/src/index.ts). Secrets bleiben
   serverseitig, das Frontend kennt nur die Proxy-URL und
   optional einen Proxy-Key.
   ============================================================ */

export interface HealthResponse {
  ok: boolean;
  coach?: boolean;
}

export interface CoachRequestSegment {
  name: string;
  dist: number;
  elev: number;
  time: number;
  watts: number;
  rank: number | null;
  komTime: number | null;
}

export class ProxyError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

export class StravaClient {
  private baseUrl: string;
  private key: string;

  constructor(baseUrl: string, key = "") {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    this.key = key.trim();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.key ? { "x-proxy-key": this.key, ...extra } : extra;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, init);
    } catch {
      throw new ProxyError("Proxy nicht erreichbar. URL pruefen.", 0);
    }
    if (res.status === 401) {
      throw new ProxyError("Proxy meldet 401: Proxy-Key pruefen.", 401);
    }
    if (res.status === 429) {
      const now = new Date();
      const nextQuarter = new Date(now);
      nextQuarter.setMinutes(Math.floor(now.getMinutes() / 15) * 15 + 15, 0, 0);
      const hh = String(nextQuarter.getHours()).padStart(2, "0");
      const mm = String(nextQuarter.getMinutes()).padStart(2, "0");
      throw new ProxyError(
        `Strava-Rate-Limit erreicht (100 Anfragen pro 15 Minuten). Ab ${hh}:${mm} Uhr geht es weiter.`,
        429
      );
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: string };
        detail = body?.error ? `: ${body.error}` : "";
      } catch {
        // Body ignorieren
      }
      throw new ProxyError(`Proxy-Fehler (${res.status})${detail}`, res.status);
    }
    return (await res.json()) as T;
  }

  private get<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const qs = params
      ? "?" +
        Object.entries(params)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    return this.request<T>(`${path}${qs}`, { headers: this.headers() });
  }

  health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health");
  }

  getAthlete(): Promise<StravaAthlete> {
    return this.get<StravaAthlete>("/athlete");
  }

  listActivities(perPage = 30, page = 1, afterEpochS?: number): Promise<SummaryActivity[]> {
    const params: Record<string, string | number | boolean> = {
      per_page: perPage,
      page,
    };
    if (afterEpochS) params.after = afterEpochS;
    return this.get<SummaryActivity[]>("/athlete/activities", params);
  }

  getActivity(id: string | number): Promise<DetailedActivity> {
    return this.get<DetailedActivity>(`/activities/${id}`, { include_all_efforts: true });
  }

  async getStreams(id: string | number): Promise<StreamSet | null> {
    try {
      return await this.get<StreamSet>(`/activities/${id}/streams`, {
        keys: "watts,time",
        key_by_type: true,
      });
    } catch (e) {
      // Kein Stream (z. B. Aktivitaet ohne Aufzeichnung) ist kein harter Fehler
      if (e instanceof ProxyError && e.status !== 401) return null;
      throw e;
    }
  }

  getSegment(id: string | number): Promise<DetailedSegment> {
    return this.get<DetailedSegment>(`/segments/${id}`);
  }

  /** Top-Segmente in einer Bounding Box (sw_lat,sw_lng,ne_lat,ne_lng) */
  async exploreSegments(
    bounds: [number, number, number, number],
    activityType: "riding" | "running"
  ): Promise<ExplorerSegment[]> {
    const res = await this.get<{ segments?: ExplorerSegment[] }>("/segments/explore", {
      bounds: bounds.map((b) => b.toFixed(5)).join(","),
      activity_type: activityType,
    });
    return res.segments ?? [];
  }

  async trainingPlan(payload: {
    sport: "ride" | "run";
    raceDate: string;
    distanceKm: number;
    targetTimeS: number;
    weight: number;
    ftp: number | null;
    curve: CurvePoint[];
    behavior: {
      weeksAnalyzed: number;
      sessionsPerWeek: number;
      hoursPerWeek: number;
      weeklyKm: number;
      longestSessionMin: number;
      typicalDays: string[];
    };
  }): Promise<{ summary: string; weeks: unknown }> {
    return this.request<{ summary: string; weeks: unknown }>("/trainingplan", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    });
  }

  async coach(payload: {
    weight: number;
    curve: CurvePoint[];
    segments: CoachRequestSegment[];
  }): Promise<CoachTarget[]> {
    const res = await this.request<{ targets?: CoachTarget[] }>("/coach", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    });
    return res.targets ?? [];
  }
}
