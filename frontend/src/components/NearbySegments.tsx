import { useState } from "react";
import { T, body, display, mono } from "../theme";
import { StravaClient } from "../lib/strava";
import {
  curveAt,
  fmtPace,
  fmtTime,
  interpolateAt,
  parseKomTime,
  physicsKomWatts,
} from "../lib/scoring";
import { useI18n } from "../lib/i18n";
import type { CurvePoint, Feasibility, Sport } from "../lib/types";
import { KomBadge } from "./KomBadge";
import { Spinner } from "./Spinner";

/* Suchradius um den Standort, ~5 km in Grad */
const RADIUS_DEG = 0.045;

interface NearbySegment {
  id: number;
  name: string;
  dist: number;
  grade: number;
  elev: number;
  komTime: number | null;
  athleteCount: number | null;
  feas: Feasibility | null;
}

export function NearbySegments({
  makeClient,
  curve,
  sport,
  weight,
}: {
  makeClient: () => StravaClient;
  curve: CurvePoint[];
  sport: Sport;
  weight: number;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<NearbySegment[] | null>(null);

  function locate(): Promise<GeolocationPosition> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error(t.errNoGeolocation));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED ? t.errGeoDenied : t.errGeoFailed
          )
        ),
        { timeout: 15000 }
      );
    });
  }

  /* Machbarkeit ohne eigenen Effort: Rad ueber Physikmodell, Laufen ueber Pace.
     Abfahrten (negatives Durchschnittsgefaelle) werden nicht bewertet, dort
     entscheidet Abfahrtskoennen statt Watt. */
  function feasibilityFor(
    dist: number,
    elev: number,
    komTime: number | null,
    grade: number
  ): Feasibility | null {
    if (!komTime || komTime <= 0) return null;
    if (sport === "ride" && grade < -1) return null;
    let need: number | null;
    let have: number | null;
    if (sport === "ride") {
      need = physicsKomWatts(dist, elev, komTime, weight);
      have = curveAt(curve, komTime);
    } else {
      need = dist / komTime;
      have = interpolateAt(curve, komTime);
    }
    if (!need || !have) return null;
    const ratio = have / need;
    const status = ratio >= 0.97 ? "attack" : ratio >= 0.85 ? "train" : "far";
    return { status, ratio, need, have };
  }

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const pos = await locate();
      const { latitude: lat, longitude: lng } = pos.coords;
      const lngPad = RADIUS_DEG / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
      const client = makeClient();
      const found = await client.exploreSegments(
        [lat - RADIUS_DEG, lng - lngPad, lat + RADIUS_DEG, lng + lngPad],
        sport === "ride" ? "riding" : "running"
      );
      if (!found.length) {
        setSegments([]);
        return;
      }
      const detailed = await Promise.all(
        found.slice(0, 10).map(async (s) => {
          let komTime: number | null = null;
          let athleteCount: number | null = null;
          try {
            const d = await client.getSegment(s.id);
            komTime = parseKomTime(d?.xoms?.kom || d?.xoms?.overall);
            athleteCount = d?.athlete_count ?? null;
          } catch {
            // Details optional, Segment trotzdem zeigen
          }
          const elev = Math.max(0, s.elev_difference || 0);
          return {
            id: s.id,
            name: s.name,
            dist: Math.round(s.distance),
            grade: s.avg_grade,
            elev,
            komTime,
            athleteCount,
            feas: feasibilityFor(s.distance, elev, komTime, s.avg_grade),
          } satisfies NearbySegment;
        })
      );
      detailed.sort((a, b) => (b.feas?.ratio ?? -1) - (a.feas?.ratio ?? -1));
      setSegments(detailed);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.errSearch);
    } finally {
      setBusy(false);
    }
  }

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
          marginBottom: segments || busy || error ? 10 : 0,
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
          {t.nearbyTitle(sport === "ride" ? "KOM" : "CR")}
        </h2>
        <button
          onClick={search}
          disabled={busy}
          style={{
            background: "transparent",
            color: T.gold,
            border: `1px solid ${T.gold}`,
            borderRadius: 8,
            padding: "8px 16px",
            fontSize: 14,
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
            ...body,
          }}
        >
          {busy ? t.searching : t.useLocation}
        </button>
      </div>

      {busy && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: T.dim, fontSize: 14 }}>
          <Spinner /> {t.searchingRadius}
        </div>
      )}
      {error && <p style={{ color: T.red, margin: 0 }}>{error}</p>}
      {segments && segments.length === 0 && (
        <p style={{ color: T.dim, margin: 0, fontSize: 14 }}>
          {t.nearbyEmpty}
        </p>
      )}

      {segments && segments.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {segments.map((s) => (
            <article
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: T.bg,
                border: `1px solid ${
                  s.feas?.status === "attack" ? T.gold + "88" : T.line
                }`,
                borderRadius: 10,
                padding: "10px 14px",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{s.name}</span>
                  <KomBadge feas={s.feas} />
                </div>
                <div
                  style={{
                    ...mono,
                    color: T.dim,
                    fontSize: 12.5,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "4px 12px",
                    marginTop: 4,
                  }}
                >
                  <span>{(s.dist / 1000).toFixed(2)} km</span>
                  <span>{s.grade.toFixed(1)} %</span>
                  {s.komTime && (
                    <span style={{ color: T.gold }}>
                      {sport === "ride" ? "KOM" : "CR"} {fmtTime(s.komTime)}
                    </span>
                  )}
                  {s.athleteCount != null && <span>{t.athletes(s.athleteCount)}</span>}
                  {s.feas?.need != null && s.feas?.have != null && (
                    <span style={{ color: s.feas.status === "attack" ? T.gold : T.teal }}>
                      {sport === "ride"
                        ? t.needHaveWatts(Math.round(s.feas.need), Math.round(s.feas.have))
                        : t.needHavePace(fmtPace(s.feas.need), fmtPace(s.feas.have))}
                    </span>
                  )}
                  {!s.feas && (
                    <span style={{ color: T.faint }}>
                      {sport === "ride" && s.grade < -1 ? t.descentNote : t.noAssessment}
                    </span>
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
        </div>
      )}

      {segments && sport === "ride" && segments.length > 0 && (
        <p style={{ color: T.faint, fontSize: 12, margin: "10px 0 0", lineHeight: 1.5 }}>
          {t.physicsNote(weight)}
        </p>
      )}
    </section>
  );
}
