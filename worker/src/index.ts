/* ============================================================
   SEGMENT HUNTER PROXY (Cloudflare Worker)

   Allgemeiner Strava-Proxy fuer das Segment-Hunter-Frontend.
   Browser koennen die Strava v3 API nicht direkt aufrufen
   (kein CORS auf oauth/token, inkonsistent auf /api/v3).
   Dieser Worker haelt Client-Secret und Refresh-Token
   serverseitig, erneuert Access Tokens selbst und liefert
   Strava-Daten mit CORS-Headern aus.

   Endpunkte:
     GET  /health                  -> { ok, coach }
     GET  /athlete                 -> Athletenprofil (Name, Gewicht)
     GET  /athlete/activities      -> Aktivitaetenliste (per_page, page)
     GET  /activities/:id          -> Aktivitaet inkl. Segment-Efforts
                                      (include_all_efforts Passthrough)
     GET  /activities/:id/streams  -> Watt/Zeit-Streams (keys Passthrough)
     GET  /segments/:id            -> Segmentdetails (xoms, athlete_count)
     POST /coach                   -> AI-Taktikplan (nur mit ANTHROPIC_API_KEY)

   Secrets (wrangler secret put ...):
     STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN,
     PROXY_KEY (optional), ANTHROPIC_API_KEY (optional, /coach)
   ============================================================ */

export interface Env {
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_REFRESH_TOKEN: string;
  PROXY_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

// Token-Cache auf Isolate-Ebene. Ueberlebt Requests innerhalb
// desselben Workers, faellt nach Neustart auf den Refresh-Flow zurueck.
let cache: { accessToken: string | null; expiresAt: number; refreshToken: string | null } = {
  accessToken: null,
  expiresAt: 0,
  refreshToken: null,
};

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-proxy-key",
  "Access-Control-Max-Age": "86400",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

async function getAccessToken(env: Env): Promise<string> {
  if (cache.accessToken && Date.now() < cache.expiresAt - 60_000) {
    return cache.accessToken;
  }
  const params = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: cache.refreshToken || env.STRAVA_REFRESH_TOKEN,
  });
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`Strava Token-Refresh fehlgeschlagen (${res.status})`);
  }
  const d = (await res.json()) as {
    access_token: string;
    expires_at?: number;
    refresh_token?: string;
  };
  cache = {
    accessToken: d.access_token,
    expiresAt: (d.expires_at || 0) * 1000,
    refreshToken: d.refresh_token || cache.refreshToken, // Strava kann rotieren
  };
  return cache.accessToken as string;
}

/* Strava-GET mit Bearer-Token, Antwort 1:1 durchreichen */
async function stravaGet(env: Env, path: string, params?: URLSearchParams): Promise<Response> {
  const token = await getAccessToken(env);
  const qs = params && [...params.keys()].length > 0 ? `?${params.toString()}` : "";
  const upstream = await fetch(`https://www.strava.com/api/v3${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

/* Query-Passthrough: nur bekannte Parameter weiterreichen */
function pick(url: URL, keys: string[]): URLSearchParams {
  const out = new URLSearchParams();
  for (const k of keys) {
    const v = url.searchParams.get(k);
    if (v !== null) out.set(k, v);
  }
  return out;
}

/* ---------- /coach: AI-Taktikplan ueber die Anthropic API ---------- */

interface CoachSegment {
  name: string;
  dist: number;
  elev: number;
  time: number;
  watts: number;
  rank: number | null;
  komTime: number | null;
}

interface CoachRequest {
  weight: number;
  curve: [number, number][];
  segments: CoachSegment[];
}

function extractJson(text: string): unknown {
  const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Keine JSON-Antwort erkannt");
  return JSON.parse(clean.slice(start, end + 1));
}

async function handleCoach(request: Request, env: Env): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "coach nicht konfiguriert (ANTHROPIC_API_KEY fehlt)" }, 501);
  }
  let body: CoachRequest;
  try {
    body = (await request.json()) as CoachRequest;
  } catch {
    return json({ error: "ungueltiger Request-Body" }, 400);
  }
  if (!body || !Array.isArray(body.curve) || !Array.isArray(body.segments) || body.segments.length === 0) {
    return json({ error: "weight, curve und segments werden benoetigt" }, 400);
  }
  const segments = body.segments.slice(0, 8);
  const prompt = `Du bist ein Radsport-Coach. Athlet: ${Math.round(body.weight)} kg.
Power-Kurve (Sekunden -> Watt): ${JSON.stringify(body.curve)}.
Segmente (Name | Distanz m | Hoehenmeter | Bestzeit s | Durchschnittswatt | PR-Rang | KOM-Zeit s):
${segments
  .map(
    (s) =>
      `${s.name}|${Math.round(s.dist)}|${Math.round(s.elev)}|${Math.round(s.time)}|${Math.round(s.watts)}|${s.rank ?? "-"}|${s.komTime ?? "-"}`
  )
  .join("\n")}

Waehle die 3 aussichtsreichsten Angriffsziele. Wenn KOM-Zeiten vorhanden sind, priorisiere
Segmente, bei denen die KOM-Zeit mit der Power-Kurve erreichbar ist.
Antworte AUSSCHLIESSLICH mit minifiziertem JSON ohne Markdown in exakt diesem Format:
{"targets":[{"name":"Segmentname","why":"Begruendung, 1 Satz","pacing":"Pacing-Taktik, 1 Satz","targetWatts":"Zielwatt, z. B. 280 W"}]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    return json({ error: `Anthropic API-Fehler (${res.status})` }, 502);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("\n");
  try {
    const parsed = extractJson(text) as { targets?: unknown };
    return json({ targets: Array.isArray(parsed.targets) ? parsed.targets : [] });
  } catch {
    return json({ error: "Coach-Antwort konnte nicht geparst werden" }, 502);
  }
}

/* ---------- Router ---------- */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Optionaler Zugriffsschutz fuer den Proxy selbst
    if (env.PROXY_KEY && request.headers.get("x-proxy-key") !== env.PROXY_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST") {
      if (path === "/coach") return handleCoach(request, env);
      return json({ error: "not found" }, 404);
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    try {
      if (path === "/health") {
        return json({ ok: true, coach: Boolean(env.ANTHROPIC_API_KEY) });
      }
      if (path === "/athlete") {
        return await stravaGet(env, "/athlete");
      }
      if (path === "/athlete/activities") {
        return await stravaGet(env, "/athlete/activities", pick(url, ["per_page", "page", "before", "after"]));
      }

      const streams = path.match(/^\/activities\/(\d+)\/streams$/);
      if (streams) {
        const params = pick(url, ["keys", "key_by_type"]);
        if (!params.has("keys")) params.set("keys", "watts,time");
        if (!params.has("key_by_type")) params.set("key_by_type", "true");
        return await stravaGet(env, `/activities/${streams[1]}/streams`, params);
      }

      const activity = path.match(/^\/activities\/(\d+)$/);
      if (activity) {
        return await stravaGet(env, `/activities/${activity[1]}`, pick(url, ["include_all_efforts"]));
      }

      const segment = path.match(/^\/segments\/(\d+)$/);
      if (segment) {
        return await stravaGet(env, `/segments/${segment[1]}`);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "proxy error" }, 502);
    }
  },
};
