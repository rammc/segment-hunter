/* ============================================================
   STRAVA KOM PROXY (Cloudflare Worker)
   Zweck: Browser-Frontends können die Strava v3 API nicht direkt
   aufrufen (kein CORS auf oauth/token, inkonsistent auf /api/v3).
   Dieser Worker haelt Client-Secret und Refresh-Token serverseitig,
   erneuert Access Tokens selbst und liefert Segmentdaten mit
   CORS-Headern aus.

   Endpunkte:
     GET /health            -> { ok: true }
     GET /segments/:id      -> Strava-Segmentdetails (inkl. xoms)

   Secrets (wrangler secret put ...):
     STRAVA_CLIENT_ID
     STRAVA_CLIENT_SECRET
     STRAVA_REFRESH_TOKEN
     PROXY_KEY (optional; wenn gesetzt, muss der Client den Header
                x-proxy-key mitsenden)

   Deployment:
     npm install -g wrangler
     wrangler login
     wrangler deploy strava-kom-proxy.worker.js --name strava-kom-proxy
     wrangler secret put STRAVA_CLIENT_ID
     wrangler secret put STRAVA_CLIENT_SECRET
     wrangler secret put STRAVA_REFRESH_TOKEN
     wrangler secret put PROXY_KEY        (optional, empfohlen)
   ============================================================ */

// Token-Cache auf Isolate-Ebene. Ueberlebt Requests innerhalb
// desselben Workers, faellt nach Neustart auf den Refresh-Flow zurueck.
let cache = { accessToken: null, expiresAt: 0, refreshToken: null };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-proxy-key",
  "Access-Control-Max-Age": "86400",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

async function getAccessToken(env) {
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
  const d = await res.json();
  cache = {
    accessToken: d.access_token,
    expiresAt: (d.expires_at || 0) * 1000,
    refreshToken: d.refresh_token || cache.refreshToken, // Strava kann rotieren
  };
  return cache.accessToken;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    // Optionaler Zugriffsschutz fuer den Proxy selbst
    if (env.PROXY_KEY && request.headers.get("x-proxy-key") !== env.PROXY_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    const match = url.pathname.match(/^\/segments\/(\d+)$/);
    if (!match) {
      return json({ error: "not found" }, 404);
    }

    try {
      const token = await getAccessToken(env);
      const upstream = await fetch(
        `https://www.strava.com/api/v3/segments/${match[1]}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: { ...CORS, "content-type": "application/json" },
      });
    } catch (e) {
      return json({ error: e.message || "proxy error" }, 502);
    }
  },
};
