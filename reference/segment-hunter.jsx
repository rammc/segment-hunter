import { useState, useMemo } from "react";

/* ============================================================
   SEGMENT HUNTER — Strava-Segment-Analyse im Head-Unit-Stil
   Flow: 1) Proxy-Setup  2) MCP-Daten  3) KOM-Check via Proxy
   Hintergrund: Direkte Browser-Calls an strava.com scheitern
   an der Artifact-Sandbox und an Stravas CORS-Policy. Der
   KOM-Abruf laeuft deshalb ueber einen eigenen Proxy
   (strava-kom-proxy.worker.js), der die Secrets serverseitig haelt.
   ============================================================ */

const T = {
  bg: "#12161B",
  panel: "#1A2129",
  line: "#2C3743",
  text: "#E9EDF1",
  dim: "#8B98A5",
  faint: "#5A6773",
  gold: "#E8B93C",
  goldSoft: "#E8B93C22",
  teal: "#4FB6A8",
  red: "#E06C55",
};

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@600;700;800&family=Saira:wght@400;500;600&family=JetBrains+Mono:wght@400;600;700&display=swap');
`;

const display = { fontFamily: "'Saira Condensed', sans-serif" };
const body = { fontFamily: "'Saira', sans-serif" };
const mono = { fontFamily: "'JetBrains Mono', monospace" };

/* ---------- Anthropic API helper ---------- */

async function callClaude(prompt, { mcp = false } = {}) {
  const bodyPayload = {
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  };
  if (mcp) {
    bodyPayload.mcp_servers = [
      { type: "url", url: "https://mcp.strava.com/mcp", name: "strava" },
    ];
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyPayload),
  });
  if (!res.ok) throw new Error(`API-Fehler (${res.status})`);
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function parseJson(text) {
  const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Keine JSON-Antwort erkannt");
  return JSON.parse(clean.slice(start, end + 1));
}

/* ---------- Fachlogik ---------- */

function curveAt(curve, sec) {
  if (!curve.length) return null;
  const sorted = [...curve].sort((a, b) => a[0] - b[0]);
  if (sec <= sorted[0][0]) return sorted[0][1];
  if (sec >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [t1, w1] = sorted[i];
    const [t2, w2] = sorted[i + 1];
    if (sec >= t1 && sec <= t2) {
      const f = (Math.log(sec) - Math.log(t1)) / (Math.log(t2) - Math.log(t1));
      return Math.round(w1 + f * (w2 - w1));
    }
  }
  return null;
}

// "5:31", "1:02:11" oder "45s" -> Sekunden
function parseKomTime(str) {
  if (!str) return null;
  const s = String(str).trim().replace("s", "");
  const parts = s.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

// Benoetigte Watt fuer die KOM-Zeit [Schaetzung ueber Steigungsmodell]
function requiredWattsForKom(seg, komTime) {
  if (!seg.watts || seg.watts < 30 || !komTime || komTime >= seg.time) return null;
  const grade = seg.dist > 0 ? (seg.elev / seg.dist) * 100 : 0;
  const k = grade >= 5 ? 1.05 : grade <= 1 ? 2.7 : 2.7 - ((grade - 1) / 4) * (2.7 - 1.05);
  return Math.round(seg.watts * Math.pow(seg.time / komTime, k));
}

function huntScore(seg, curve) {
  const ref = curveAt(curve, seg.time);
  let headroom = 0;
  if (ref && seg.watts > 30) headroom = Math.max(0, (ref - seg.watts) / ref);
  const rankBonus =
    seg.rank != null ? Math.max(0, Math.min(1, (60 - seg.rank) / 60)) : 0.3;
  const reliable = seg.watts > 30 && seg.time >= 30;
  const raw = 100 * ((0.7 * Math.min(headroom, 0.6)) / 0.6 + 0.3 * rankBonus);
  return { score: Math.round(raw), ref, headroom, reliable };
}

function komFeasibility(seg, curve) {
  if (!seg.komTime) return null;
  if (seg.komTime >= seg.time) return { status: "kom", ratio: 1 };
  const need = requiredWattsForKom(seg, seg.komTime);
  const have = curveAt(curve, seg.komTime);
  if (!need || !have) return null;
  const ratio = have / need;
  const status = ratio >= 0.97 ? "attack" : ratio >= 0.85 ? "train" : "far";
  return { status, ratio, need, have, gap: seg.time - seg.komTime };
}

function fmtTime(s) {
  if (s == null) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.round(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return m > 0 ? `${m}:${String(r).padStart(2, "0")} min` : `${r} s`;
}

/* ---------- UI-Bausteine ---------- */

function Crown({ size = 18, color = T.gold }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 18h18l-1.4-9-4.6 4L12 5l-3 8-4.6-4L3 18z" fill={color} />
    </svg>
  );
}

function Spinner() {
  return (
    <>
      <div aria-hidden="true" style={{ display: "inline-block", width: 28, height: 28, border: `3px solid ${T.line}`, borderTopColor: T.gold, borderRadius: "50%", animation: "sh-spin 0.9s linear infinite" }} />
      <style>{`@keyframes sh-spin{to{transform:rotate(360deg)}} @media (prefers-reduced-motion: reduce){*{animation:none!important}}`}</style>
    </>
  );
}

function ScoreDial({ score }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const col = score >= 65 ? T.gold : score >= 40 ? T.teal : T.faint;
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label={`Hunt-Score ${score}`}>
      <circle cx="36" cy="36" r={r} stroke={T.line} strokeWidth="6" fill="none" />
      <circle
        cx="36" cy="36" r={r} stroke={col} strokeWidth="6" fill="none"
        strokeDasharray={`${c * pct} ${c}`} strokeLinecap="round"
        transform="rotate(-90 36 36)"
      />
      <text x="36" y="41" textAnchor="middle" fill={T.text} fontSize="18"
        style={{ ...mono, fontWeight: 700 }}>{score}</text>
    </svg>
  );
}

function KomBadge({ feas }) {
  if (!feas) return null;
  const map = {
    kom: { label: "DU HÄLTST DEN KOM", bg: T.gold, fg: "#1A1608" },
    attack: { label: "KOM IN REICHWEITE", bg: T.gold, fg: "#1A1608" },
    train: { label: "MIT TRAINING MACHBAR", bg: T.teal, fg: "#0E1B19" },
    far: { label: "AUSSER REICHWEITE", bg: T.line, fg: T.dim },
  };
  const s = map[feas.status];
  return (
    <span style={{ ...display, background: s.bg, color: s.fg, fontSize: 11, fontWeight: 700, letterSpacing: 0.8, padding: "3px 8px", borderRadius: 4, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

function Field({ label, value, onChange, secret = false, placeholder, flex = "1 1 260px" }) {
  return (
    <label style={{ display: "block", flex }}>
      <span style={{ color: T.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8, display: "block", marginBottom: 4 }}>
        {label}
      </span>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ ...mono, width: "100%", boxSizing: "border-box", background: T.bg, color: T.text, border: `1px solid ${T.line}`, borderRadius: 8, padding: "10px 12px", fontSize: 13 }}
      />
    </label>
  );
}

function PowerCurve({ curve, weight }) {
  if (!curve.length) return null;
  const sorted = [...curve].sort((a, b) => a[0] - b[0]);
  const W = 560, H = 180, P = 34;
  const xs = sorted.map(([s]) => Math.log(s));
  const ws = sorted.map(([, w]) => w);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const wMax = Math.max(...ws) * 1.1;
  const px = (s) => P + ((Math.log(s) - xMin) / (xMax - xMin)) * (W - 2 * P);
  const py = (w) => H - P - (w / wMax) * (H - 2 * P);
  const path = sorted.map(([s, w], i) => `${i ? "L" : "M"}${px(s).toFixed(1)},${py(w).toFixed(1)}`).join(" ");
  const ticks = [5, 30, 120, 600, 3600].filter((s) => s >= sorted[0][0] && s <= sorted[sorted.length - 1][0]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Power-Kurve">
      {ticks.map((s) => (
        <g key={s}>
          <line x1={px(s)} y1={P} x2={px(s)} y2={H - P} stroke={T.line} strokeDasharray="2 4" />
          <text x={px(s)} y={H - P + 16} textAnchor="middle" fill={T.faint} fontSize="10" style={mono}>
            {s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : "1h"}
          </text>
        </g>
      ))}
      <path d={path} stroke={T.gold} strokeWidth="2.5" fill="none" />
      {sorted.map(([s, w]) => (
        <circle key={s} cx={px(s)} cy={py(w)} r="3" fill={T.bg} stroke={T.gold} strokeWidth="2">
          <title>{`${fmtTime(s)}: ${w} W (${(w / weight).toFixed(1)} W/kg)`}</title>
        </circle>
      ))}
    </svg>
  );
}

/* ---------- Haupt-App ---------- */

export default function SegmentHunter() {
  const [phase, setPhase] = useState("setup"); // setup | loading | ready
  const [step, setStep] = useState("");
  const [error, setError] = useState(null);
  const [athlete, setAthlete] = useState(null);
  const [segments, setSegments] = useState([]);
  const [curve, setCurve] = useState([]);
  const [ai, setAi] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [komState, setKomState] = useState("off"); // off | ok | error
  const [komMsg, setKomMsg] = useState(null);

  // Proxy-Konfiguration: die Secrets (Client-ID, Client-Secret,
  // Refresh-Token) liegen im Cloudflare Worker, nie im Browser.
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyKey, setProxyKey] = useState("");

  const weight = athlete?.weight || 71;
  const komConfigured = proxyUrl.trim().length > 0;

  function proxyHeaders() {
    return proxyKey.trim() ? { "x-proxy-key": proxyKey.trim() } : {};
  }

  function proxyBase() {
    return proxyUrl.trim().replace(/\/+$/, "");
  }

  /* KOM-Zeiten ueber den eigenen Proxy (Strava xoms) */
  async function loadKomTimes(segList) {
    if (!komConfigured) {
      setKomState("off");
      return segList;
    }
    setStep("Lade KOM-Zeiten über den Proxy …");
    try {
      const targets = segList.slice(0, 20);
      const results = await Promise.all(
        targets.map(async (s) => {
          try {
            const res = await fetch(`${proxyBase()}/segments/${s.id}`, {
              headers: proxyHeaders(),
            });
            if (res.status === 401) throw new Error("401");
            if (!res.ok) return { id: s.id, komTime: null };
            const d = await res.json();
            return {
              id: s.id,
              komTime: parseKomTime(d?.xoms?.kom || d?.xoms?.overall),
              athleteCount: d?.athlete_count ?? null,
            };
          } catch (e) {
            if (e.message === "401") throw e;
            return { id: s.id, komTime: null };
          }
        })
      );
      const byId = new Map(results.map((r) => [r.id, r]));
      const merged = segList.map((s) => {
        const k = byId.get(s.id);
        return k ? { ...s, komTime: k.komTime, athleteCount: k.athleteCount } : s;
      });
      const found = merged.filter((s) => s.komTime).length;
      setKomState("ok");
      setKomMsg(`${found} von ${targets.length} KOM-Zeiten geladen.`);
      return merged;
    } catch (e) {
      setKomState("error");
      setKomMsg(
        e.message === "401"
          ? "Proxy meldet 401: Proxy-Key prüfen."
          : "KOM-Abruf über den Proxy fehlgeschlagen. Proxy-URL prüfen."
      );
      return segList;
    }
  }

  /* Kompletter Ladefluss, auch fuer "Aktualisieren" */
  async function loadAll() {
    setError(null);
    setAi(null);
    setKomMsg(null);
    const isRefresh = phase === "ready";
    if (isRefresh) setRefreshing(true);
    else setPhase("loading");
    try {
      // Proxy zuerst validieren, damit Setup-Fehler sofort sichtbar sind
      if (komConfigured) {
        setStep("Prüfe Proxy-Verbindung …");
        const h = await fetch(`${proxyBase()}/health`, { headers: proxyHeaders() });
        if (h.status === 401) throw new Error("Proxy meldet 401: Proxy-Key prüfen.");
        if (!h.ok) throw new Error(`Proxy nicht erreichbar (${h.status}). URL prüfen.`);
      }

      setStep("Verbinde mit Strava und lade Profil + Aktivitäten …");
      const t1 = await callClaude(
        `Rufe über die Strava-Tools get_athlete_profile und list_activities (first: 30) auf.
Antworte AUSSCHLIESSLICH mit minifiziertem JSON ohne Markdown:
{"a":{"name":"...","weight":kg},"r":[["id","name","YYYY-MM-DD",km,hm,pr_count]]}
In "r" nur Outdoor-Radaktivitäten (Ride, GravelRide, MountainBikeRide) mit Distanz > 2 km,
maximal 8 Stück, neueste zuerst. km und hm auf eine Nachkommastelle gerundet.`,
        { mcp: true }
      );
      const d1 = parseJson(t1);
      const rideList = (d1.r || []).map(([id, name, date, km, hm, prs]) => ({
        id: String(id), name, date, km, hm, prs,
      }));
      setAthlete({ name: d1.a?.name || "Athlet", weight: d1.a?.weight || 71 });
      if (!rideList.length) throw new Error("Keine Radaktivitäten gefunden.");

      const targets = rideList.slice(0, 6);
      const segMap = new Map();
      const curveMap = new Map();
      for (let i = 0; i < targets.length; i += 2) {
        const chunk = targets.slice(i, i + 2);
        setStep(`Analysiere Fahrten ${i + 1}–${Math.min(i + 2, targets.length)} von ${targets.length} …`);
        const t2 = await callClaude(
          `Rufe über die Strava-Tools get_activity_performance für diese Aktivitäts-IDs auf: ${chunk
            .map((r) => r.id)
            .join(", ")}.
Antworte AUSSCHLIESSLICH mit minifiziertem JSON ohne Markdown:
{"s":[["segment_id","name",dist_m,elev_m,moving_time_s,avg_watts,pr_rank_oder_null]],"p":[[sekunden,watt]]}
"s": alle Segment-Efforts beider Aktivitäten. pr_rank aus pr_achievements, falls die entity_id
zu einem Segment-Effort passt, sonst null. Watt auf ganze Zahlen runden.
"p": alle GreatestPower-Bestwerte als [Dauer in Sekunden, Watt] (5s=5, 1min=60, 1hr=3600 usw.).`,
          { mcp: true }
        );
        let d2;
        try {
          d2 = parseJson(t2);
        } catch {
          continue;
        }
        (d2.s || []).forEach(([sid, name, dist, elev, time, watts, rank]) => {
          const key = String(sid);
          const prev = segMap.get(key);
          const entry = {
            id: key, name, dist: Math.round(dist), elev: Math.round(elev * 10) / 10,
            time: Math.round(time), watts: Math.round(watts || 0),
            rank: rank ?? prev?.rank ?? null,
            efforts: (prev?.efforts || 0) + 1,
          };
          if (!prev || entry.time < prev.time) segMap.set(key, entry);
          else segMap.set(key, { ...prev, efforts: entry.efforts, rank: entry.rank ?? prev.rank });
        });
        (d2.p || []).forEach(([sec, w]) => {
          if (!curveMap.has(sec) || curveMap.get(sec) < w) curveMap.set(sec, w);
        });
      }

      let segList = [...segMap.values()];
      segList = await loadKomTimes(segList);

      setSegments(segList);
      setCurve([...curveMap.entries()].map(([s, w]) => [Number(s), w]));
      setPhase("ready");
      setStep("");
    } catch (e) {
      setError(e.message || "Unbekannter Fehler");
      if (!isRefresh) setPhase("setup");
    } finally {
      setRefreshing(false);
    }
  }

  async function runAiAnalysis() {
    setAiBusy(true);
    setAi(null);
    try {
      const top = scored.filter((s) => s.reliable).slice(0, 8);
      const t = await callClaude(
        `Du bist ein Radsport-Coach. Athlet: ${weight} kg. Power-Kurve (s→W): ${JSON.stringify(
          curve
        )}. Segmente (Name | Distanz m | Höhenmeter | Bestzeit s | Ø Watt | PR-Rang | KOM-Zeit s): ${top
          .map((s) => `${s.name}|${s.dist}|${s.elev}|${s.time}|${s.watts}|${s.rank ?? "-"}|${s.komTime ?? "-"}`)
          .join(" ;; ")}.
Wähle die 3 aussichtsreichsten Angriffsziele. Wenn KOM-Zeiten vorhanden sind, priorisiere
Segmente, bei denen die KOM-Zeit mit der Power-Kurve erreichbar ist. Antworte AUSSCHLIESSLICH mit JSON:
{"t":[{"n":"Segmentname","w":"Begründung, 1 Satz","p":"Pacing-Taktik, 1 Satz","z":"Zielwatt, z. B. 280 W"}]}`
      );
      const d = parseJson(t);
      setAi(d.t || []);
    } catch (e) {
      setError("AI-Analyse fehlgeschlagen: " + (e.message || ""));
    } finally {
      setAiBusy(false);
    }
  }

  const scored = useMemo(() => {
    const list = segments.map((s) => ({
      ...s,
      ...huntScore(s, curve),
      feas: komFeasibility(s, curve),
    }));
    return list.sort((a, b) => {
      const fa = a.feas?.ratio ?? -1;
      const fb = b.feas?.ratio ?? -1;
      if (komState === "ok" && fa !== fb) return fb - fa;
      return b.score - a.score;
    });
  }, [segments, curve, komState]);

  const wkg5 = curveAt(curve, 300);
  const attackable = scored.filter((s) => s.feas && (s.feas.status === "attack" || s.feas.status === "kom")).length;

  return (
    <div style={{ ...body, background: T.bg, color: T.text, minHeight: "100vh" }}>
      <style>{FONTS}</style>

      {/* Kopfzeile */}
      <header style={{ borderBottom: `1px solid ${T.line}` }}>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 20px 16px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Crown size={26} />
              <h1 style={{ ...display, fontWeight: 800, fontSize: 30, letterSpacing: 1, margin: 0, textTransform: "uppercase" }}>
                Segment&nbsp;Hunter
              </h1>
            </div>
            <p style={{ color: T.dim, margin: "6px 0 0", fontSize: 14, maxWidth: 560 }}>
              KOM-Zeiten gegen deine Power-Kurve: sehen, wo der Angriff realistisch ist.
            </p>
          </div>
          {phase === "ready" && (
            <button
              onClick={loadAll}
              disabled={refreshing}
              style={{
                ...display, background: "transparent", color: T.gold,
                border: `1px solid ${T.gold}`, borderRadius: 8, padding: "10px 18px",
                fontSize: 15, fontWeight: 700, letterSpacing: 0.5,
                cursor: refreshing ? "wait" : "pointer", textTransform: "uppercase",
              }}
            >
              {refreshing ? "Aktualisiere …" : "↻ Aktualisieren"}
            </button>
          )}
        </div>
      </header>

      <main style={{ maxWidth: 960, margin: "0 auto", padding: 20 }}>
        {/* Schritt 1: Proxy-Setup */}
        {phase === "setup" && (
          <section style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: 24 }}>
            <h2 style={{ ...display, fontSize: 20, letterSpacing: 0.8, margin: "0 0 4px", textTransform: "uppercase", color: T.gold }}>
              1 · KOM-Proxy verbinden
            </h2>
            <p style={{ color: T.dim, fontSize: 14, margin: "0 0 14px", lineHeight: 1.5 }}>
              Browser können die Strava-API nicht direkt aufrufen: Strava setzt auf
              oauth/token bewusst keine CORS-Header, und diese Umgebung erlaubt ohnehin
              nur Anfragen an die Anthropic API. Der KOM-Check läuft deshalb über deinen
              eigenen Cloudflare Worker (strava-kom-proxy.worker.js), der Client-Secret
              und Refresh-Token serverseitig hält. Hier nur dessen URL eintragen.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              <Field label="Proxy-URL" value={proxyUrl} onChange={setProxyUrl}
                placeholder="https://strava-kom-proxy.<account>.workers.dev" flex="2 1 320px" />
              <Field label="Proxy-Key (optional)" value={proxyKey} onChange={setProxyKey} secret
                placeholder="falls PROXY_KEY gesetzt" flex="1 1 200px" />
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={loadAll}
                disabled={!komConfigured}
                style={{
                  ...display, background: komConfigured ? T.gold : T.line,
                  color: komConfigured ? "#1A1608" : T.faint, border: "none",
                  borderRadius: 8, padding: "12px 26px", fontSize: 17, fontWeight: 700,
                  letterSpacing: 0.5, cursor: komConfigured ? "pointer" : "not-allowed",
                  textTransform: "uppercase",
                }}
              >
                Verbinden & KOM-Check starten
              </button>
              <button
                onClick={loadAll}
                style={{
                  background: "transparent", color: T.dim, border: `1px solid ${T.line}`,
                  borderRadius: 8, padding: "11px 18px", fontSize: 14, cursor: "pointer", ...body,
                }}
              >
                Ohne KOM-Modus starten (nur eigene Reserve)
              </button>
            </div>
            {error && <p style={{ color: T.red, marginBottom: 0 }}>{error}</p>}
          </section>
        )}

        {/* Ladezustand */}
        {phase === "loading" && (
          <section style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: 28, textAlign: "center" }}>
            <Spinner />
            <p style={{ color: T.dim, marginBottom: 0 }}>{step}</p>
          </section>
        )}

        {phase === "ready" && (
          <>
            {refreshing && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, background: T.panel, border: `1px solid ${T.line}`, borderRadius: 8, padding: "8px 14px", marginBottom: 12, color: T.dim, fontSize: 14 }}>
                <Spinner /> {step}
              </div>
            )}

            {/* Athleten-Leiste */}
            <section style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
              {[
                ["Athlet", athlete?.name],
                ["Gewicht", `${weight} kg`],
                wkg5 ? ["5-min-Power", `${wkg5} W · ${(wkg5 / weight).toFixed(1)} W/kg`] : null,
                ["Segmente", scored.length],
                komState === "ok" ? ["KOM in Reichweite", attackable] : null,
              ]
                .filter(Boolean)
                .map(([k, v]) => (
                  <div key={k} style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 8, padding: "8px 14px" }}>
                    <div style={{ color: T.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8 }}>{k}</div>
                    <div style={{ ...mono, fontSize: 15, fontWeight: 600 }}>{v}</div>
                  </div>
                ))}
            </section>

            {/* KOM-Status */}
            <section style={{ background: T.panel, border: `1px solid ${komState === "ok" ? T.gold + "66" : T.line}`, borderRadius: 12, padding: "12px 18px", marginBottom: 16, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ ...display, fontSize: 15, letterSpacing: 0.8, textTransform: "uppercase", color: komState === "ok" ? T.gold : komState === "error" ? T.red : T.dim }}>
                KOM-Modus: {komState === "ok" ? "aktiv" : komState === "error" ? "Fehler" : "aus"}
              </span>
              <span style={{ color: komState === "error" ? T.red : T.dim, fontSize: 14 }}>
                {komMsg || (komState === "off" ? "Ohne Proxy gestartet — Liste zeigt nur die eigene Leistungsreserve." : "")}
              </span>
              {komState !== "ok" && (
                <button
                  onClick={() => { setPhase("setup"); setError(null); }}
                  style={{ background: "transparent", color: T.gold, border: `1px solid ${T.gold}`, borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", ...body }}
                >
                  Proxy-Setup öffnen
                </button>
              )}
            </section>

            {/* Power-Kurve */}
            <section style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: 18, marginBottom: 16 }}>
              <h2 style={{ ...display, fontSize: 18, letterSpacing: 0.8, margin: "0 0 8px", textTransform: "uppercase", color: T.dim }}>
                Power-Kurve (Bestwerte der analysierten Fahrten)
              </h2>
              <PowerCurve curve={curve} weight={weight} />
            </section>

            {/* Hunt-Liste */}
            <section>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                <h2 style={{ ...display, fontSize: 22, letterSpacing: 0.8, margin: 0, textTransform: "uppercase" }}>
                  Angriffsziele
                </h2>
                <button
                  onClick={runAiAnalysis}
                  disabled={aiBusy}
                  style={{
                    background: "transparent", color: T.gold, border: `1px solid ${T.gold}`,
                    borderRadius: 8, padding: "8px 16px", fontSize: 14, fontWeight: 600,
                    cursor: aiBusy ? "wait" : "pointer", ...body,
                  }}
                >
                  {aiBusy ? "Analysiere …" : "AI-Taktikplan erstellen"}
                </button>
              </div>

              {ai && (
                <div style={{ background: T.goldSoft, border: `1px solid ${T.gold}55`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
                  <h3 style={{ ...display, margin: "0 0 8px", fontSize: 16, textTransform: "uppercase", letterSpacing: 0.8, color: T.gold }}>
                    Taktikplan
                  </h3>
                  {ai.map((t, i) => (
                    <div key={i} style={{ padding: "8px 0", borderTop: i ? `1px solid ${T.line}` : "none" }}>
                      <div style={{ fontWeight: 600 }}>
                        {t.n} <span style={{ ...mono, color: T.gold, fontSize: 13 }}>→ Ziel {t.z}</span>
                      </div>
                      <div style={{ color: T.dim, fontSize: 14 }}>{t.w} {t.p}</div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: "grid", gap: 10 }}>
                {scored.map((s) => (
                  <article key={s.id} style={{ display: "flex", alignItems: "center", gap: 16, background: T.panel, border: `1px solid ${s.feas?.status === "attack" || s.feas?.status === "kom" ? T.gold + "88" : s.score >= 65 ? T.gold + "44" : T.line}`, borderRadius: 12, padding: "12px 16px" }}>
                    <ScoreDial score={s.score} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600, fontSize: 16 }}>{s.name}</span>
                        {s.rank != null && s.rank <= 10 && <Crown size={14} />}
                        <KomBadge feas={s.feas} />
                      </div>
                      <div style={{ ...mono, color: T.dim, fontSize: 13, display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 4 }}>
                        <span>{(s.dist / 1000).toFixed(2)} km</span>
                        <span>{s.elev} hm</span>
                        <span>PB {fmtTime(s.time)}</span>
                        <span>{s.watts > 30 ? `${s.watts} W` : "— W"}</span>
                        {s.rank != null && <span style={{ color: T.gold }}>PR-Rang {s.rank}</span>}
                        {s.komTime && s.komTime < s.time && (
                          <span style={{ color: T.gold }}>KOM {fmtTime(s.komTime)} (−{fmtTime(s.time - s.komTime)})</span>
                        )}
                        {s.feas?.need && (
                          <span style={{ color: s.feas.status === "attack" ? T.gold : T.teal }}>
                            benötigt ≈{s.feas.need} W, du hast {s.feas.have} W
                          </span>
                        )}
                        {!s.feas && s.ref && s.reliable && s.ref > s.watts && (
                          <span style={{ color: T.teal }}>Reserve +{s.ref - s.watts} W</span>
                        )}
                        {!s.reliable && <span style={{ color: T.faint }}>[geringe Datenqualität]</span>}
                      </div>
                    </div>
                    <a
                      href={`https://www.strava.com/segments/${s.id}`}
                      target="_blank" rel="noreferrer"
                      style={{ color: T.faint, fontSize: 12, textDecoration: "none", ...mono }}
                      aria-label={`Segment ${s.name} auf Strava öffnen`}
                    >
                      Strava ↗
                    </a>
                  </article>
                ))}
              </div>
            </section>

            <footer style={{ color: T.faint, fontSize: 12, marginTop: 20, lineHeight: 1.6 }}>
              Hunt-Score = Reserve deiner Power-Kurve auf der Segmentdauer (70 %) plus
              PR-Rang-Bonus (30 %). KOM-Machbarkeit = Power-Kurve auf der KOM-Dauer geteilt
              durch benötigte Watt [Schätzung: P∝v bei Steigung ≥5 %, P∝v²·⁷ im Flachen,
              dazwischen geblendet — Wind, Aero-Position und Taktik nicht modelliert].
              Datenquellen: Segment-Efforts über Strava MCP, KOM-Zeiten über eigenen
              Proxy (Strava v3 xoms).
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
