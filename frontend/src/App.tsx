import { useMemo, useRef, useState } from "react";
import { T, body, display, mono } from "./theme";
import { StravaClient, ProxyError } from "./lib/strava";
import {
  buildPowerCurve,
  buildSpeedCurve,
  curveAt,
  curveSupports,
  estimatedFromSec,
  fmtPace,
  fmtTime,
  ftpCurvePoints,
  huntScore,
  interpolateAt,
  komFeasibility,
  parseKomTime,
  riegelEfforts,
  runFeasibility,
  runHuntScore,
  speedSupports,
} from "./lib/scoring";
import type { StreamInput } from "./lib/scoring";
import { BEHAVIOR_WINDOW_DAYS } from "./lib/plan";
import type {
  ActivityRef,
  CoachTarget,
  CurvePoint,
  CurveSupport,
  DetailedActivity,
  Feasibility,
  HuntScore,
  SegmentEntry,
  Sport,
  SummaryActivity,
  TaggedPoint,
  TaggedRunEffort,
  TargetMark,
} from "./lib/types";
import { useI18n } from "./lib/i18n";
import { Crown } from "./components/Crown";
import { Spinner } from "./components/Spinner";
import { ScoreDial } from "./components/ScoreDial";
import { KomBadge } from "./components/KomBadge";
import { Field } from "./components/Field";
import { PowerCurve } from "./components/PowerCurve";
import { CurveSupportTable } from "./components/CurveSupportTable";
import { SportToggle } from "./components/SportToggle";
import { LangToggle } from "./components/LangToggle";
import { NearbySegments } from "./components/NearbySegments";
import { FilterChips } from "./components/FilterBar";
import { TrainingPlanSection } from "./components/TrainingPlanSection";

/* Outdoor-Aktivitaeten je Sportart */
const RIDE_TYPES = new Set(["Ride", "GravelRide", "MountainBikeRide"]);
const RUN_TYPES = new Set(["Run", "TrailRun"]);
const MIN_DISTANCE_M = 2000;
const INITIAL_ACTIVITIES = 12; // zunaechst analysierte Aktivitaeten (die aussichtsreichsten)
const LOAD_MORE_ACTIVITIES = 6; // pro "Mehr laden"-Klick
const ALWAYS_RECENT = 3; // die juengsten passenden Aktivitaeten sind immer dabei
const MAX_KOM_LOOKUPS = 15; // Bestzeiten-Abfragen pro Ladevorgang
const ACTIVITY_CHUNK = 3;

type Phase = "setup" | "loading" | "ready";
type KomState = "off" | "ok" | "error";
type LenFilter = "all" | "short" | "mid" | "long";
type GradeFilter = "all" | "flat" | "rolling" | "climb";
type FeasFilter = "all" | "attack" | "train";

interface Athlete {
  name: string;
  weight: number;
  ftp: number | null;
}

type ScoredSegment = SegmentEntry & HuntScore & { feas: Feasibility | null };

/* Akkumulierter Ladezustand fuer inkrementelles Nachladen */
interface DataStore {
  sport: Sport;
  ftp: number | null;
  candidates: SummaryActivity[];
  analyzed: number; // Index in candidates, bis wohin analysiert wurde
  streams: StreamInput[];
  wattPoints: TaggedPoint[];
  runEfforts: TaggedRunEffort[];
  segMap: Map<string, SegmentEntry>;
  komChecked: Set<string>;
  komFound: number;
}

export default function SegmentHunter() {
  const { lang, t } = useI18n();
  const [phase, setPhase] = useState<Phase>("setup");
  const [sport, setSport] = useState<Sport>("ride");
  const [step, setStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [athlete, setAthlete] = useState<Athlete | null>(null);
  const [recentActivities, setRecentActivities] = useState<SummaryActivity[]>([]);
  const [segments, setSegments] = useState<SegmentEntry[]>([]);
  const [curve, setCurve] = useState<CurvePoint[]>([]);
  const [supports, setSupports] = useState<CurveSupport[]>([]);
  const [estFrom, setEstFrom] = useState<number | null>(null);
  const [ai, setAi] = useState<CoachTarget[] | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [coachAvailable, setCoachAvailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [komState, setKomState] = useState<KomState>("off");
  const [komMsg, setKomMsg] = useState<string | null>(null);

  const [lenFilter, setLenFilter] = useState<LenFilter>("all");
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [feasFilter, setFeasFilter] = useState<FeasFilter>("all");

  const dataRef = useRef<DataStore | null>(null);

  // Proxy-Konfiguration: die Secrets (Client-ID, Client-Secret, Refresh-Token)
  // liegen im Cloudflare Worker, nie im Browser. VITE_PROXY_URL fuellt das
  // Feld vor; URL und Proxy-Key werden nach erfolgreichem Verbinden im
  // localStorage gemerkt, damit das Passwort nicht jedes Mal faellig ist.
  const [proxyUrl, setProxyUrl] = useState<string>(
    () => readStored("sh:proxyUrl") || import.meta.env.VITE_PROXY_URL || ""
  );
  const [proxyKey, setProxyKey] = useState<string>(() => readStored("sh:proxyKey"));

  const weight = athlete?.weight || 71;
  const configured = proxyUrl.trim().length > 0;
  const crLabel = sport === "ride" ? "KOM" : "CR";

  function makeClient(): StravaClient {
    return new StravaClient(proxyUrl, proxyKey);
  }

  function scoreFor(seg: SegmentEntry, curvePoints: CurvePoint[], s: Sport): HuntScore {
    return s === "ride" ? huntScore(seg, curvePoints) : runHuntScore(seg, curvePoints);
  }

  function buildCurveFor(store: DataStore): CurvePoint[] {
    return store.sport === "ride"
      ? buildPowerCurve(store.streams, [
          ...store.wattPoints.map((p) => [p.sec, p.value] as CurvePoint),
          ...ftpCurvePoints(store.ftp),
        ])
      : // Riegel-Punkte verankern das lange Ende als Rennpotenzial statt Trainingstempo
        buildSpeedCurve([...store.runEfforts, ...riegelEfforts(store.runEfforts)]);
  }

  /* Naechsten Schwung Aktivitaeten analysieren und in den Store einsammeln */
  async function analyzeBatch(client: StravaClient, store: DataStore, count: number) {
    const end = Math.min(store.analyzed + count, store.candidates.length);
    const total = end - store.analyzed;
    for (let i = store.analyzed; i < end; i += ACTIVITY_CHUNK) {
      const chunk = store.candidates.slice(i, Math.min(i + ACTIVITY_CHUNK, end));
      setStep(
        t.stepAnalyze(
          store.sport,
          i - store.analyzed + 1,
          Math.min(i - store.analyzed + chunk.length, total),
          total
        )
      );
      const loaded = await Promise.all(
        chunk.map(async (a) => {
          const [activity, streamSet] = await Promise.all([
            client.getActivity(a.id),
            store.sport === "ride" ? client.getStreams(a.id) : Promise.resolve(null),
          ]);
          return { activity, streamSet };
        })
      );
      for (const { activity, streamSet } of loaded) {
        if (store.sport === "ride") {
          collectRideActivity(activity, store.segMap, store.wattPoints);
          if (streamSet?.watts?.data?.length && streamSet?.time?.data?.length) {
            store.streams.push({
              time: streamSet.time.data,
              watts: streamSet.watts.data,
              activity: activityRef(activity),
            });
          }
        } else {
          collectRunActivity(activity, store.segMap, store.runEfforts);
        }
      }
    }
    store.analyzed = end;
  }

  /* Bestzeiten fuer die aussichtsreichsten, noch ungeprueften Segmente holen */
  async function fetchKomTimes(client: StravaClient, store: DataStore, curvePoints: CurvePoint[]) {
    const label = store.sport === "ride" ? "KOM" : "CR";
    const unchecked = [...store.segMap.values()].filter((s) => !store.komChecked.has(s.id));
    const targets = unchecked
      .sort((a, b) => scoreFor(b, curvePoints, store.sport).score - scoreFor(a, curvePoints, store.sport).score)
      .slice(0, MAX_KOM_LOOKUPS);
    if (!targets.length) return;
    setStep(t.stepKom(label));
    try {
      const results = await Promise.all(
        targets.map(async (seg) => {
          try {
            const d = await client.getSegment(seg.id);
            return {
              id: seg.id,
              komTime: parseKomTime(d?.xoms?.kom || d?.xoms?.overall),
              athleteCount: d?.athlete_count ?? null,
            };
          } catch (e) {
            if (e instanceof ProxyError && e.status === 401) throw e;
            return { id: seg.id, komTime: null, athleteCount: null };
          }
        })
      );
      for (const r of results) {
        store.komChecked.add(r.id);
        const seg = store.segMap.get(r.id);
        if (seg) {
          store.segMap.set(r.id, { ...seg, komTime: r.komTime, athleteCount: r.athleteCount });
        }
        if (r.komTime) store.komFound += 1;
      }
      setKomState("ok");
      setKomMsg(t.komFound(store.komFound, store.komChecked.size, label));
    } catch (e) {
      setKomState("error");
      setKomMsg(e instanceof ProxyError && e.status === 401 ? t.errProxy401 : t.errKomFetch);
    }
  }

  /* Store-Inhalt in den React-State uebernehmen */
  function publish(store: DataStore, curvePoints: CurvePoint[]) {
    setSegments([...store.segMap.values()]);
    setCurve(curvePoints);
    const sup =
      store.sport === "ride"
        ? curveSupports(store.streams, store.wattPoints, store.ftp)
        : speedSupports(store.runEfforts);
    setSupports(sup);
    setEstFrom(estimatedFromSec(curvePoints, sup, store.sport));
    setRemaining(store.candidates.length - store.analyzed);
  }

  /* Kompletter Ladefluss, auch fuer "Aktualisieren" und Sport-Wechsel */
  async function loadAll(targetSport: Sport = sport) {
    setError(null);
    setAi(null);
    setKomMsg(null);
    setKomState("off");
    const isRefresh = phase === "ready";
    if (isRefresh) setRefreshing(true);
    else setPhase("loading");
    try {
      const client = makeClient();

      setStep(t.stepHealth);
      const health = await client.health();
      if (!health.ok) throw new Error(t.errProxyUnreachable);
      setCoachAvailable(Boolean(health.coach));
      writeStored("sh:proxyUrl", proxyUrl.trim());
      writeStored("sh:proxyKey", proxyKey.trim());

      setStep(t.stepAthlete);
      let name = t.athlete;
      let kg = 71;
      let ftp: number | null = null;
      try {
        const a = await client.getAthlete();
        name = [a.firstname, a.lastname].filter(Boolean).join(" ") || name;
        if (a.weight && a.weight > 30) kg = a.weight;
        if (a.ftp && a.ftp > 0) ftp = a.ftp;
      } catch {
        // Profil ist optional, Defaults reichen
      }
      setAthlete({ name, weight: kg, ftp });

      setStep(t.stepActivities);
      const wanted = targetSport === "ride" ? RIDE_TYPES : RUN_TYPES;
      // after auf volle Stunden gerundet, damit der Worker-Cache greifen kann
      const afterEpochS =
        Math.floor((Date.now() - BEHAVIOR_WINDOW_DAYS * 86400 * 1000) / 3600000) * 3600;
      let activities = await client.listActivities(200, 1, afterEpochS);
      if (activities.length === 200) {
        activities = [...activities, ...(await client.listActivities(200, 2, afterEpochS))];
      }
      // Strava liefert bei "after" aelteste zuerst; wir wollen neueste zuerst
      activities = [...activities].sort((a, b) =>
        b.start_date_local.localeCompare(a.start_date_local)
      );
      setRecentActivities(activities);
      const candidates = rankActivities(activities, wanted, targetSport);
      if (!candidates.length) {
        throw new Error(targetSport === "ride" ? t.errNoRides : t.errNoRuns);
      }

      const store: DataStore = {
        sport: targetSport,
        ftp,
        candidates,
        analyzed: 0,
        streams: [],
        wattPoints: [],
        runEfforts: [],
        segMap: new Map(),
        komChecked: new Set(),
        komFound: 0,
      };
      dataRef.current = store;

      await analyzeBatch(client, store, INITIAL_ACTIVITIES);

      setStep(t.stepCurve(targetSport));
      const curvePoints = buildCurveFor(store);
      if (!curvePoints.length) {
        throw new Error(targetSport === "ride" ? t.errNoPower : t.errNoRunEfforts);
      }

      await fetchKomTimes(client, store, curvePoints);
      publish(store, curvePoints);
      setSport(targetSport);
      setPhase("ready");
      setStep("");
    } catch (e) {
      setError(e instanceof Error ? e.message : t.errUnknown);
      if (!isRefresh) setPhase("setup");
    } finally {
      setRefreshing(false);
    }
  }

  /* Lazy Load: naechste Aktivitaeten analysieren und weitere Bestzeiten holen */
  async function loadMore() {
    const store = dataRef.current;
    if (!store || loadingMore || refreshing) return;
    setLoadingMore(true);
    setError(null);
    try {
      const client = makeClient();
      await analyzeBatch(client, store, LOAD_MORE_ACTIVITIES);
      const curvePoints = buildCurveFor(store);
      await fetchKomTimes(client, store, curvePoints);
      publish(store, curvePoints);
      setStep("");
    } catch (e) {
      setError(e instanceof Error ? e.message : t.errLoadMore);
    } finally {
      setLoadingMore(false);
    }
  }

  function switchSport(s: Sport) {
    if (s === sport || refreshing || loadingMore) return;
    setSport(s);
    if (phase === "ready") void loadAll(s);
  }

  async function runAiAnalysis() {
    setAiBusy(true);
    setAi(null);
    try {
      const client = makeClient();
      const top = scored.filter((s) => s.reliable).slice(0, 8);
      const targets = await client.coach({
        lang,
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
      setError(t.errAi + (e instanceof Error ? e.message : ""));
    } finally {
      setAiBusy(false);
    }
  }

  const scored = useMemo<ScoredSegment[]>(() => {
    const list = segments.map((s) => ({
      ...s,
      ...(sport === "ride" ? huntScore(s, curve) : runHuntScore(s, curve)),
      feas: sport === "ride" ? komFeasibility(s, curve) : runFeasibility(s, curve),
    }));
    return list.sort((a, b) => {
      const fa = a.feas?.ratio ?? -1;
      const fb = b.feas?.ratio ?? -1;
      if (komState === "ok" && fa !== fb) return fb - fa;
      return b.score - a.score;
    });
  }, [segments, curve, komState, sport]);

  const filtered = useMemo(() => {
    return scored.filter((s) => {
      if (lenFilter === "short" && s.dist >= 1000) return false;
      if (lenFilter === "mid" && (s.dist < 1000 || s.dist > 5000)) return false;
      if (lenFilter === "long" && s.dist <= 5000) return false;
      const grade = s.dist > 0 ? (s.elev / s.dist) * 100 : 0;
      if (gradeFilter === "flat" && grade >= 3) return false;
      if (gradeFilter === "rolling" && (grade < 3 || grade >= 6)) return false;
      if (gradeFilter === "climb" && grade < 6) return false;
      if (feasFilter === "attack" && !(s.feas && (s.feas.status === "attack" || s.feas.status === "kom")))
        return false;
      if (
        feasFilter === "train" &&
        !(s.feas && (s.feas.status === "attack" || s.feas.status === "kom" || s.feas.status === "train"))
      )
        return false;
      return true;
    });
  }, [scored, lenFilter, gradeFilter, feasFilter]);

  /* KOM-/CR-Ziele als Overlay in der Kurven-Grafik: benoetigter Wert auf
     der Bestzeit-Dauer, gold wenn in Reichweite */
  const chartTargets = useMemo<TargetMark[]>(
    () =>
      scored
        .filter(
          (s) =>
            s.feas != null &&
            s.feas.need != null &&
            s.feas.have != null &&
            s.feas.status !== "kom" &&
            s.komTime != null
        )
        .sort((a, b) => (b.feas?.ratio ?? 0) - (a.feas?.ratio ?? 0))
        .slice(0, 8)
        .map((s) => ({
          name: s.name,
          sec: s.komTime as number,
          value: s.feas?.need as number,
          have: s.feas?.have as number,
          feasible: s.feas?.status === "attack",
        })),
    [scored]
  );

  const fiveMin = sport === "ride" ? curveAt(curve, 300) : interpolateAt(curve, 300);
  const attackable = scored.filter(
    (s) => s.feas && (s.feas.status === "attack" || s.feas.status === "kom")
  ).length;
  const busy = refreshing || loadingMore;

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
              {t.tagline(sport)}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <SportToggle sport={sport} onChange={switchSport} disabled={busy || phase === "loading"} />
            <LangToggle />
            {phase === "ready" && (
              <button
                onClick={() => loadAll()}
                disabled={busy}
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
                  cursor: busy ? "wait" : "pointer",
                  textTransform: "uppercase",
                }}
              >
                {refreshing ? t.refreshing : t.refresh}
              </button>
            )}
          </div>
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
              {t.setupTitle}
            </h2>
            <p style={{ color: T.dim, fontSize: 14, margin: "0 0 14px", lineHeight: 1.5 }}>
              {t.setupText}
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              <Field
                label={t.proxyUrl}
                value={proxyUrl}
                onChange={setProxyUrl}
                placeholder="https://strava-kom-proxy.<account>.workers.dev"
                flex="2 1 320px"
              />
              <Field
                label={t.proxyKey}
                value={proxyKey}
                onChange={setProxyKey}
                secret
                placeholder={t.proxyKeyPlaceholder}
                flex="1 1 200px"
              />
            </div>
            <button
              onClick={() => loadAll()}
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
              {t.connect}
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
            {busy && (
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

            {error && <p style={{ color: T.red, marginTop: 0 }}>{error}</p>}

            {/* Athleten-Leiste */}
            <section style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
              {(
                [
                  [t.athlete, athlete?.name],
                  [t.weight, `${weight} kg`],
                  sport === "ride" && athlete?.ftp ? ["FTP", `${athlete.ftp} W`] : null,
                  fiveMin
                    ? [
                        sport === "ride" ? t.fiveMinPower : t.fiveMinPace,
                        sport === "ride"
                          ? `${fiveMin} W · ${(fiveMin / weight).toFixed(1)} W/kg`
                          : fmtPace(fiveMin),
                      ]
                    : null,
                  [t.segments, scored.length],
                  komState === "ok" ? [t.withinReach(crLabel), attackable] : null,
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

            {/* KOM/CR-Status */}
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
                {t.komMode(crLabel)}{" "}
                {komState === "ok" ? t.modeOn : komState === "error" ? t.modeError : t.modeOff}
              </span>
              <span style={{ color: komState === "error" ? T.red : T.dim, fontSize: 14 }}>
                {komMsg || ""}
              </span>
            </section>

            {/* Standort: Segmente in der Naehe; key wie beim Trainingsplan */}
            <NearbySegments
              key={`nearby-${sport}`}
              makeClient={makeClient}
              curve={curve}
              sport={sport}
              weight={weight}
            />

            {/* Trainingsplan Builder + Kalender; key erzwingt Remount beim
                Sport-Wechsel, damit der Plan der jeweiligen Sportart laedt */}
            <TrainingPlanSection
              key={sport}
              makeClient={makeClient}
              sport={sport}
              weight={weight}
              ftp={athlete?.ftp ?? null}
              curve={curve}
              activities={recentActivities}
              available={coachAvailable}
            />

            {/* Power-/Pace-Kurve */}
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
                {t.curveTitle(sport)}
              </h2>
              <PowerCurve
                curve={curve}
                weight={weight}
                sport={sport}
                supports={supports}
                targets={chartTargets}
                estimatedFrom={estFrom}
              />
              <h3
                style={{
                  ...display,
                  fontSize: 13,
                  letterSpacing: 0.8,
                  margin: "14px 0 0",
                  textTransform: "uppercase",
                  color: T.faint,
                }}
              >
                {t.supportsTitle}
              </h3>
              <CurveSupportTable supports={supports} sport={sport} weight={weight} />
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
                  {t.huntTitle}
                </h2>
                {coachAvailable && sport === "ride" && (
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
                    {aiBusy ? t.aiBusy : t.aiButton}
                  </button>
                )}
              </div>

              {/* Filter */}
              <div
                style={{
                  background: T.panel,
                  border: `1px solid ${T.line}`,
                  borderRadius: 12,
                  padding: "12px 16px",
                  marginBottom: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <FilterChips
                  label={t.filterLength}
                  value={lenFilter}
                  onChange={setLenFilter}
                  options={[
                    { value: "all", label: t.filterAll },
                    { value: "short", label: "< 1 km" },
                    { value: "mid", label: "1-5 km" },
                    { value: "long", label: "> 5 km" },
                  ]}
                />
                <FilterChips
                  label={t.filterGrade}
                  value={gradeFilter}
                  onChange={setGradeFilter}
                  options={[
                    { value: "all", label: t.filterAll },
                    { value: "flat", label: t.filterFlat },
                    { value: "rolling", label: t.filterRolling },
                    { value: "climb", label: t.filterClimb },
                  ]}
                />
                <FilterChips
                  label={t.filterChance}
                  value={feasFilter}
                  onChange={setFeasFilter}
                  options={[
                    { value: "all", label: t.filterAll },
                    { value: "attack", label: t.filterAttack },
                    { value: "train", label: t.filterTrain },
                  ]}
                />
                <span style={{ color: T.faint, fontSize: 12 }}>
                  {t.filterCount(filtered.length, scored.length)}
                </span>
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
                    {t.aiPlanTitle}
                  </h3>
                  {ai.map((target, i) => (
                    <div
                      key={i}
                      style={{ padding: "8px 0", borderTop: i ? `1px solid ${T.line}` : "none" }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        {target.name}{" "}
                        <span style={{ ...mono, color: T.gold, fontSize: 13 }}>
                          {`${t.aiTarget} ${target.targetWatts}`}
                        </span>
                      </div>
                      <div style={{ color: T.dim, fontSize: 14 }}>
                        {target.why} {target.pacing}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: "grid", gap: 10 }}>
                {filtered.map((s) => (
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
                      <div
                        style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
                      >
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
                        <span>
                          {sport === "ride"
                            ? s.watts > 30
                              ? `${s.watts} W`
                              : "- W"
                            : fmtPace(s.time > 0 ? s.dist / s.time : null)}
                        </span>
                        {s.rank != null && (
                          <span style={{ color: T.gold }}>
                            {t.rank(crLabel, s.rank)}
                          </span>
                        )}
                        {s.prRank != null && s.rank == null && (
                          <span style={{ color: T.gold }}>{t.prRank(s.prRank)}</span>
                        )}
                        {s.komTime && s.komTime < s.time && (
                          <span style={{ color: T.gold }}>
                            {crLabel} {fmtTime(s.komTime)} (−{fmtTime(s.time - s.komTime)})
                          </span>
                        )}
                        {s.feas?.need != null && s.feas?.have != null && s.feas.status !== "kom" && (
                          <span style={{ color: s.feas.status === "attack" ? T.gold : T.teal }}>
                            {sport === "ride"
                              ? t.needHaveWatts(Math.round(s.feas.need), Math.round(s.feas.have))
                              : t.needHavePace(fmtPace(s.feas.need), fmtPace(s.feas.have))}
                          </span>
                        )}
                        {!s.feas && s.ref && s.reliable && sport === "ride" && s.ref > s.watts && (
                          <span style={{ color: T.teal }}>
                            {t.reserve(Math.round(s.ref - s.watts))}
                          </span>
                        )}
                        {!s.reliable && (
                          <span style={{ color: T.faint }}>{t.lowQuality}</span>
                        )}
                      </div>
                    </div>
                    <a
                      href={`https://www.strava.com/segments/${s.id}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: T.faint, fontSize: 12, textDecoration: "none", ...mono }}
                      aria-label={t.openOnStrava(s.name)}
                    >
                      Strava ↗
                    </a>
                  </article>
                ))}
                {filtered.length === 0 && (
                  <p style={{ color: T.dim, margin: 0 }}>
                    {t.emptyFilter}
                  </p>
                )}
              </div>

              {/* Lazy Load */}
              {(remaining > 0 || segments.some((s) => !dataRef.current?.komChecked.has(s.id))) && (
                <div style={{ textAlign: "center", marginTop: 14 }}>
                  <button
                    onClick={loadMore}
                    disabled={busy}
                    style={{
                      ...display,
                      background: "transparent",
                      color: T.dim,
                      border: `1px solid ${T.line}`,
                      borderRadius: 8,
                      padding: "10px 22px",
                      fontSize: 14,
                      fontWeight: 700,
                      letterSpacing: 0.5,
                      cursor: busy ? "wait" : "pointer",
                      textTransform: "uppercase",
                    }}
                  >
                    {loadingMore
                      ? t.loadMoreBusy
                      : remaining > 0
                        ? t.loadMore(remaining)
                        : t.loadMoreKom}
                  </button>
                </div>
              )}
            </section>

            <footer style={{ color: T.faint, fontSize: 12, marginTop: 20, lineHeight: 1.6 }}>
              {sport === "ride" ? t.footerRide : t.footerRun}
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

/* localStorage-Zugriff, tolerant gegen Private Mode und geblockte Storage-APIs */
function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStored(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage nicht verfuegbar: dann eben ohne Merken
  }
}

/**
 * Kandidaten sortieren: die juengsten passenden Aktivitaeten zuerst (aktuelle
 * Form), danach der Rest nach Bestleistungs-Signalen (PRs, Achievements, hohe
 * Durchschnittsleistung bzw. -geschwindigkeit, Suffer Score). So landen die
 * harten Einheiten in der Kurve statt nur der letzten lockeren Ausfahrten.
 */
function rankActivities(
  all: SummaryActivity[],
  wanted: Set<string>,
  sport: Sport
): SummaryActivity[] {
  const eligible = all
    .filter((a) => wanted.has(a.type) || wanted.has(a.sport_type ?? ""))
    .filter((a) => a.distance > MIN_DISTANCE_M);
  const recent = eligible.slice(0, ALWAYS_RECENT);
  const signal = (a: SummaryActivity) =>
    (a.pr_count ?? 0) * 20 +
    (a.achievement_count ?? 0) * 2 +
    (a.suffer_score ?? 0) / 10 +
    (sport === "ride" ? (a.average_watts ?? 0) / 5 : (a.average_speed ?? 0) * 10);
  const rest = eligible.slice(ALWAYS_RECENT).sort((a, b) => signal(b) - signal(a));
  return [...recent, ...rest];
}

/** Herkunfts-Referenz fuer Kurven-Stuetzpunkte */
function activityRef(activity: DetailedActivity): ActivityRef {
  return {
    id: activity.id,
    name: activity.name,
    date: activity.start_date_local.slice(0, 10),
  };
}

/* Segment-Efforts und Kurvenpunkte aus einer Radaktivitaet einsammeln */
function collectRideActivity(
  activity: DetailedActivity,
  segMap: Map<string, SegmentEntry>,
  effortPoints: TaggedPoint[]
) {
  const ref = activityRef(activity);
  for (const effort of activity.segment_efforts ?? []) {
    const seg = effort.segment;
    if (!seg) continue;
    const watts = Math.round(effort.average_watts || 0);
    mergeSegmentEntry(segMap, effort, watts);
    // Effort als Kurvenpunkt (Untergrenze), falls plausible Watt vorliegen
    if (watts > 30 && effort.moving_time >= 30) {
      effortPoints.push({ sec: Math.round(effort.moving_time), value: watts, activity: ref });
    }
  }
  // Gesamtaktivitaet als langer Kurvenpunkt
  const actWatts = Math.round(activity.weighted_average_watts || activity.average_watts || 0);
  if (actWatts > 30 && activity.moving_time >= 300) {
    effortPoints.push({ sec: Math.round(activity.moving_time), value: actWatts, activity: ref });
  }
}

/* Segment-Efforts und Pace-Punkte aus einem Lauf einsammeln */
function collectRunActivity(
  activity: DetailedActivity,
  segMap: Map<string, SegmentEntry>,
  runEfforts: TaggedRunEffort[]
) {
  const ref = activityRef(activity);
  for (const be of activity.best_efforts ?? []) {
    runEfforts.push({ distance: be.distance, moving_time: be.moving_time, activity: ref });
  }
  for (const effort of activity.segment_efforts ?? []) {
    const seg = effort.segment;
    if (!seg) continue;
    mergeSegmentEntry(segMap, effort, 0);
    runEfforts.push({ distance: seg.distance, moving_time: effort.moving_time, activity: ref });
  }
  // Gesamtlauf als langer Pace-Punkt
  if (activity.distance > 0 && activity.moving_time > 0) {
    runEfforts.push({ distance: activity.distance, moving_time: activity.moving_time, activity: ref });
  }
}

function mergeSegmentEntry(
  segMap: Map<string, SegmentEntry>,
  effort: NonNullable<DetailedActivity["segment_efforts"]>[number],
  watts: number
) {
  const seg = effort.segment;
  const key = String(seg.id);
  const prev = segMap.get(key);
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
}
