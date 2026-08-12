import { useMemo, useState } from "react";
import { T, body, display, mono } from "./theme";
import { StravaClient, ProxyError } from "./lib/strava";
import {
  buildPowerCurve,
  curveAt,
  fmtTime,
  huntScore,
  komFeasibility,
  parseKomTime,
} from "./lib/scoring";
import type { StreamInput } from "./lib/scoring";
import type {
  CoachTarget,
  CurvePoint,
  DetailedActivity,
  SegmentEntry,
} from "./lib/types";
import { Crown } from "./components/Crown";
import { Spinner } from "./components/Spinner";
import { ScoreDial } from "./components/ScoreDial";
import { KomBadge } from "./components/KomBadge";
import { Field } from "./components/Field";
import { PowerCurve } from "./components/PowerCurve";

/* Outdoor-Radaktivitaeten, wie im Prototyp */
const RIDE_TYPES = new Set(["Ride", "GravelRide", "MountainBikeRide"]);
const MIN_DISTANCE_M = 2000;
const MAX_RIDES = 8; // mehr als die 6 des Prototyps, Strava-Rate-Limit im Blick
const MAX_KOM_LOOKUPS = 15;
const ACTIVITY_CHUNK = 3;

type Phase = "setup" | "loading" | "ready";
type KomState = "off" | "ok" | "error";

interface Athlete {
  name: string;
  weight: number;
}

export default function SegmentHunter() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [step, setStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [athlete, setAthlete] = useState<Athlete | null>(null);
  const [segments, setSegments] = useState<SegmentEntry[]>([]);
  const [curve, setCurve] = useState<CurvePoint[]>([]);
  const [ai, setAi] = useState<CoachTarget[] | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [coachAvailable, setCoachAvailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [komState, setKomState] = useState<KomState>("off");
  const [komMsg, setKomMsg] = useState<string | null>(null);

  // Proxy-Konfiguration: die Secrets (Client-ID, Client-Secret, Refresh-Token)
  // liegen im Cloudflare Worker, nie im Browser. VITE_PROXY_URL fuellt das
  // Feld vor, kann aber ueberschrieben werden.
  const [proxyUrl, setProxyUrl] = useState<string>(import.meta.env.VITE_PROXY_URL ?? "");
  const [proxyKey, setProxyKey] = useState("");

  const weight = athlete?.weight || 71;
  const configured = proxyUrl.trim().length > 0;

  function makeClient(): StravaClient {
    return new StravaClient(proxyUrl, proxyKey);
  }

  /* KOM-Zeiten fuer die aussichtsreichsten Segmente nachladen */
  async function loadKomTimes(client: StravaClient, segList: SegmentEntry[], curvePoints: CurvePoint[]): Promise<SegmentEntry[]> {
    setStep("Lade KOM-Zeiten über den Proxy …");
    // Erst grob nach Hunt-Score sortieren, damit die Lookups die Top-Segmente treffen
    const ranked = [...segList].sort(
      (a, b) => huntScore(b, curvePoints).score - huntScore(a, curvePoints).score
    );
    const targets = ranked.slice(0, MAX_KOM_LOOKUPS);
    try {
      const results = await Promise.all(
        targets.map(async (s) => {
          try {
            const d = await client.getSegment(s.id);
            return {
              id: s.id,
              komTime: parseKomTime(d?.xoms?.kom || d?.xoms?.overall),
              athleteCount: d?.athlete_count ?? null,
            };
          } catch (e) {
            if (e instanceof ProxyError && e.status === 401) throw e;
            return { id: s.id, komTime: null, athleteCount: null };
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
        e instanceof ProxyError && e.status === 401
          ? "Proxy meldet 401: Proxy-Key prüfen."
          : "KOM-Abruf über den Proxy fehlgeschlagen."
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
      const client = makeClient();

      setStep("Prüfe Proxy-Verbindung …");
      const health = await client.health();
      if (!health.ok) throw new Error("Proxy nicht erreichbar. URL prüfen.");
      setCoachAvailable(Boolean(health.coach));

      setStep("Lade Athletenprofil …");
      let name = "Athlet";
      let kg = 71;
      try {
        const a = await client.getAthlete();
        name = [a.firstname, a.lastname].filter(Boolean).join(" ") || name;
        if (a.weight && a.weight > 30) kg = a.weight;
      } catch {
        // Profil ist optional, Defaults reichen
      }
      setAthlete({ name, weight: kg });

      setStep("Lade Aktivitäten …");
      const activities = await client.listActivities(30, 1);
      const rides = activities
        .filter((a) => RIDE_TYPES.has(a.type) || RIDE_TYPES.has(a.sport_type ?? ""))
        .filter((a) => a.distance > MIN_DISTANCE_M)
        .slice(0, MAX_RIDES);
      if (!rides.length) throw new Error("Keine Radaktivitäten gefunden.");

      const segMap = new Map<string, SegmentEntry>();
      const streams: StreamInput[] = [];
      const effortPoints: CurvePoint[] = [];

      for (let i = 0; i < rides.length; i += ACTIVITY_CHUNK) {
        const chunk = rides.slice(i, i + ACTIVITY_CHUNK);
        setStep(
          `Analysiere Fahrten ${i + 1}-${Math.min(i + chunk.length, rides.length)} von ${rides.length} …`
        );
        const loaded = await Promise.all(
          chunk.map(async (r) => {
            const [activity, streamSet] = await Promise.all([
              client.getActivity(r.id),
              client.getStreams(r.id),
            ]);
            return { activity, streamSet };
          })
        );
        for (const { activity, streamSet } of loaded) {
          collectActivity(activity, segMap, effortPoints);
          if (streamSet?.watts?.data?.length && streamSet?.time?.data?.length) {
            streams.push({ time: streamSet.time.data, watts: streamSet.watts.data });
          }
        }
      }

      setStep("Berechne Power-Kurve …");
      const curvePoints = buildPowerCurve(streams, effortPoints);
      if (!curvePoints.length) {
        throw new Error(
          "Keine Leistungsdaten gefunden. Ohne Watt-Werte (Powermeter oder Schätzung) kann nichts bewertet werden."
        );
      }

      let segList = [...segMap.values()];
      segList = await loadKomTimes(client, segList, curvePoints);

      setSegments(segList);
      setCurve(curvePoints);
      setPhase("ready");
      setStep("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unbekannter Fehler");
      if (!isRefresh) setPhase("setup");
    } finally {
      setRefreshing(false);
    }
  }

  async function runAiAnalysis() {
    setAiBusy(true);
    setAi(null);
    try {
      const client = makeClient();
      const top = scored.filter((s) => s.reliable).slice(0, 8);
      const targets = await client.coach({
        weight,
        curve,
        segments: top.map((s) => ({
          name: s.name,
          dist: s.dist,
          elev: s.elev,
          time: s.time,
          watts: s.watts,
          rank: s.rank,
          komTime: s.komTime ?? null,
        })),
      });
      setAi(targets);
    } catch (e) {
      setError("AI-Analyse fehlgeschlagen: " + (e instanceof Error ? e.message : ""));
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
  const attackable = scored.filter(
    (s) => s.feas && (s.feas.status === "attack" || s.feas.status === "kom")
  ).length;

  return (
    <div style={{ ...body, background: T.bg, color: T.text, minHeight: "100vh" }}>
      {/* Kopfzeile */}
      <header style={{ borderBottom: `1px solid ${T.line}` }}>
        <div
          style={{
            maxWidth: 960,
            margin: "0 auto",
            padding: "20px 20px 16px",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Crown size={26} />
              <h1
                style={{
                  ...display,
                  fontWeight: 800,
                  fontSize: 30,
                  letterSpacing: 1,
                  margin: 0,
                  textTransform: "uppercase",
                }}
              >
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
                ...display,
                background: "transparent",
                color: T.gold,
                border: `1px solid ${T.gold}`,
                borderRadius: 8,
                padding: "10px 18px",
                fontSize: 15,
                fontWeight: 700,
                letterSpacing: 0.5,
                cursor: refreshing ? "wait" : "pointer",
                textTransform: "uppercase",
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
          <section
            style={{
              background: T.panel,
              border: `1px solid ${T.line}`,
              borderRadius: 12,
              padding: 24,
            }}
          >
            <h2
              style={{
                ...display,
                fontSize: 20,
                letterSpacing: 0.8,
                margin: "0 0 4px",
                textTransform: "uppercase",
                color: T.gold,
              }}
            >
              1 · Strava-Proxy verbinden
            </h2>
            <p style={{ color: T.dim, fontSize: 14, margin: "0 0 14px", lineHeight: 1.5 }}>
              Browser können die Strava-API nicht direkt aufrufen: Strava setzt auf oauth/token
              bewusst keine CORS-Header. Alle Daten laufen deshalb über deinen eigenen Cloudflare
              Worker, der Client-Secret und Refresh-Token serverseitig hält. Hier nur dessen URL
              eintragen.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              <Field
                label="Proxy-URL"
                value={proxyUrl}
                onChange={setProxyUrl}
                placeholder="https://strava-kom-proxy.<account>.workers.dev"
                flex="2 1 320px"
              />
              <Field
                label="Proxy-Key (optional)"
                value={proxyKey}
                onChange={setProxyKey}
                secret
                placeholder="falls PROXY_KEY gesetzt"
                flex="1 1 200px"
              />
            </div>
            <button
              onClick={loadAll}
              disabled={!configured}
              style={{
                ...display,
                background: configured ? T.gold : T.line,
                color: configured ? "#1A1608" : T.faint,
                border: "none",
                borderRadius: 8,
                padding: "12px 26px",
                fontSize: 17,
                fontWeight: 700,
                letterSpacing: 0.5,
                cursor: configured ? "pointer" : "not-allowed",
                textTransform: "uppercase",
              }}
            >
              Verbinden & Analyse starten
            </button>
            {error && <p style={{ color: T.red, marginBottom: 0 }}>{error}</p>}
          </section>
        )}

        {/* Ladezustand */}
        {phase === "loading" && (
          <section
            style={{
              background: T.panel,
              border: `1px solid ${T.line}`,
              borderRadius: 12,
              padding: 28,
              textAlign: "center",
            }}
          >
            <Spinner />
            <p style={{ color: T.dim, marginBottom: 0 }}>{step}</p>
          </section>
        )}

        {phase === "ready" && (
          <>
            {refreshing && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: T.panel,
                  border: `1px solid ${T.line}`,
                  borderRadius: 8,
                  padding: "8px 14px",
                  marginBottom: 12,
                  color: T.dim,
                  fontSize: 14,
                }}
              >
                <Spinner /> {step}
              </div>
            )}

            {error && (
              <p style={{ color: T.red, marginTop: 0 }}>{error}</p>
            )}

            {/* Athleten-Leiste */}
            <section style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
              {(
                [
                  ["Athlet", athlete?.name],
                  ["Gewicht", `${weight} kg`],
                  wkg5 ? ["5-min-Power", `${wkg5} W · ${(wkg5 / weight).toFixed(1)} W/kg`] : null,
                  ["Segmente", scored.length],
                  komState === "ok" ? ["KOM in Reichweite", attackable] : null,
                ] as Array<[string, string | number | undefined] | null>
              )
                .filter((x): x is [string, string | number | undefined] => Boolean(x))
                .map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      background: T.panel,
                      border: `1px solid ${T.line}`,
                      borderRadius: 8,
                      padding: "8px 14px",
                    }}
                  >
                    <div
                      style={{
                        color: T.faint,
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: 0.8,
                      }}
                    >
                      {k}
                    </div>
                    <div style={{ ...mono, fontSize: 15, fontWeight: 600 }}>{v}</div>
                  </div>
                ))}
            </section>

            {/* KOM-Status */}
            <section
              style={{
                background: T.panel,
                border: `1px solid ${komState === "ok" ? T.gold + "66" : T.line}`,
                borderRadius: 12,
                padding: "12px 18px",
                marginBottom: 16,
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  ...display,
                  fontSize: 15,
                  letterSpacing: 0.8,
                  textTransform: "uppercase",
                  color: komState === "ok" ? T.gold : komState === "error" ? T.red : T.dim,
                }}
              >
                KOM-Modus: {komState === "ok" ? "aktiv" : komState === "error" ? "Fehler" : "aus"}
              </span>
              <span style={{ color: komState === "error" ? T.red : T.dim, fontSize: 14 }}>
                {komMsg || ""}
              </span>
            </section>

            {/* Power-Kurve */}
            <section
              style={{
                background: T.panel,
                border: `1px solid ${T.line}`,
                borderRadius: 12,
                padding: 18,
                marginBottom: 16,
              }}
            >
              <h2
                style={{
                  ...display,
                  fontSize: 18,
                  letterSpacing: 0.8,
                  margin: "0 0 8px",
                  textTransform: "uppercase",
                  color: T.dim,
                }}
              >
                Power-Kurve (Bestwerte der analysierten Fahrten)
              </h2>
              <PowerCurve curve={curve} weight={weight} />
            </section>

            {/* Hunt-Liste */}
            <section>
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
                    fontSize: 22,
                    letterSpacing: 0.8,
                    margin: 0,
                    textTransform: "uppercase",
                  }}
                >
                  Angriffsziele
                </h2>
                {coachAvailable && (
                  <button
                    onClick={runAiAnalysis}
                    disabled={aiBusy}
                    style={{
                      background: "transparent",
                      color: T.gold,
                      border: `1px solid ${T.gold}`,
                      borderRadius: 8,
                      padding: "8px 16px",
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: aiBusy ? "wait" : "pointer",
                      ...body,
                    }}
                  >
                    {aiBusy ? "Analysiere …" : "AI-Taktikplan erstellen"}
                  </button>
                )}
              </div>

              {ai && (
                <div
                  style={{
                    background: T.goldSoft,
                    border: `1px solid ${T.gold}55`,
                    borderRadius: 12,
                    padding: 16,
                    marginBottom: 14,
                  }}
                >
                  <h3
                    style={{
                      ...display,
                      margin: "0 0 8px",
                      fontSize: 16,
                      textTransform: "uppercase",
                      letterSpacing: 0.8,
                      color: T.gold,
                    }}
                  >
                    Taktikplan
                  </h3>
                  {ai.map((t, i) => (
                    <div
                      key={i}
                      style={{ padding: "8px 0", borderTop: i ? `1px solid ${T.line}` : "none" }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        {t.name}{" "}
                        <span style={{ ...mono, color: T.gold, fontSize: 13 }}>
                          → Ziel {t.targetWatts}
                        </span>
                      </div>
                      <div style={{ color: T.dim, fontSize: 14 }}>
                        {t.why} {t.pacing}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: "grid", gap: 10 }}>
                {scored.map((s) => (
                  <article
                    key={s.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 16,
                      background: T.panel,
                      border: `1px solid ${
                        s.feas?.status === "attack" || s.feas?.status === "kom"
                          ? T.gold + "88"
                          : s.score >= 65
                            ? T.gold + "44"
                            : T.line
                      }`,
                      borderRadius: 12,
                      padding: "12px 16px",
                    }}
                  >
                    <ScoreDial score={s.score} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600, fontSize: 16 }}>{s.name}</span>
                        {s.rank != null && s.rank <= 10 && <Crown size={14} />}
                        <KomBadge feas={s.feas} />
                      </div>
                      <div
                        style={{
                          ...mono,
                          color: T.dim,
                          fontSize: 13,
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "4px 14px",
                          marginTop: 4,
                        }}
                      >
                        <span>{(s.dist / 1000).toFixed(2)} km</span>
                        <span>{s.elev} hm</span>
                        <span>PB {fmtTime(s.time)}</span>
                        <span>{s.watts > 30 ? `${s.watts} W` : "- W"}</span>
                        {s.rank != null && <span style={{ color: T.gold }}>KOM-Rang {s.rank}</span>}
                        {s.prRank != null && s.rank == null && (
                          <span style={{ color: T.gold }}>PR-Rang {s.prRank}</span>
                        )}
                        {s.komTime && s.komTime < s.time && (
                          <span style={{ color: T.gold }}>
                            KOM {fmtTime(s.komTime)} (−{fmtTime(s.time - s.komTime)})
                          </span>
                        )}
                        {s.feas?.need && (
                          <span style={{ color: s.feas.status === "attack" ? T.gold : T.teal }}>
                            benötigt ≈{s.feas.need} W, du hast {s.feas.have} W
                          </span>
                        )}
                        {!s.feas && s.ref && s.reliable && s.ref > s.watts && (
                          <span style={{ color: T.teal }}>Reserve +{s.ref - s.watts} W</span>
                        )}
                        {!s.reliable && (
                          <span style={{ color: T.faint }}>[geringe Datenqualität]</span>
                        )}
                      </div>
                    </div>
                    <a
                      href={`https://www.strava.com/segments/${s.id}`}
                      target="_blank"
                      rel="noreferrer"
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
              Hunt-Score = Reserve deiner Power-Kurve auf der Segmentdauer (70 %) plus Rang-Bonus
              (30 %). KOM-Machbarkeit = Power-Kurve auf der KOM-Dauer geteilt durch benötigte Watt
              (Schätzung: P∝v bei Steigung ≥5 %, P∝v²·⁷ im Flachen, dazwischen geblendet; Wind,
              Aero-Position und Taktik sind nicht modelliert). Datenquellen: Segment-Efforts und
              Watt-Streams über den eigenen Proxy (Strava v3), KOM-Zeiten aus den Segmentdetails
              (xoms).
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

/* Segment-Efforts und Kurvenpunkte aus einer Aktivitaet einsammeln */
function collectActivity(
  activity: DetailedActivity,
  segMap: Map<string, SegmentEntry>,
  effortPoints: CurvePoint[]
) {
  for (const effort of activity.segment_efforts ?? []) {
    const seg = effort.segment;
    if (!seg) continue;
    const key = String(seg.id);
    const prev = segMap.get(key);
    const watts = Math.round(effort.average_watts || 0);
    const entry: SegmentEntry = {
      id: key,
      name: seg.name || effort.name,
      dist: Math.round(seg.distance),
      elev: Math.round(Math.max(0, seg.elevation_high - seg.elevation_low) * 10) / 10,
      time: Math.round(effort.moving_time),
      watts,
      rank: effort.kom_rank ?? prev?.rank ?? null,
      prRank: effort.pr_rank ?? prev?.prRank ?? null,
      efforts: (prev?.efforts || 0) + 1,
    };
    if (!prev || entry.time < prev.time) {
      segMap.set(key, { ...prev, ...entry });
    } else {
      segMap.set(key, {
        ...prev,
        efforts: entry.efforts,
        rank: entry.rank ?? prev.rank,
        prRank: entry.prRank ?? prev.prRank,
      });
    }
    // Effort als Kurvenpunkt (Untergrenze), falls plausible Watt vorliegen
    if (watts > 30 && effort.moving_time >= 30) {
      effortPoints.push([Math.round(effort.moving_time), watts]);
    }
  }
  // Gesamtaktivitaet als langer Kurvenpunkt
  const actWatts = Math.round(activity.weighted_average_watts || activity.average_watts || 0);
  if (actWatts > 30 && activity.moving_time >= 300) {
    effortPoints.push([Math.round(activity.moving_time), actWatts]);
  }
}
