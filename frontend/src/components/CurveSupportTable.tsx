import { T, mono } from "../theme";
import { fmtPace, fmtTime } from "../lib/scoring";
import { useI18n } from "../lib/i18n";
import type { CurveSupport, Sport, SupportKind } from "../lib/types";

/**
 * Stuetzpunkte der Kurve als Tabelle: welche eigene Einheit traegt welchen
 * Bestwert, mit Linkout zur Aktivitaet auf Strava. Untermauert die Grafik.
 */
export function CurveSupportTable({
  supports,
  sport,
  weight,
}: {
  supports: CurveSupport[];
  sport: Sport;
  weight: number;
}) {
  const { t } = useI18n();
  if (!supports.length) return null;
  const isRide = sport === "ride";

  const kindLabel: Record<SupportKind, string> = {
    stream: t.kindStream,
    effort: t.kindEffort,
    ftp: t.kindFtp,
  };

  const th: React.CSSProperties = {
    color: T.faint,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    textAlign: "left",
    fontWeight: 400,
    padding: "6px 14px 6px 0",
    borderBottom: `1px solid ${T.line}`,
  };
  const td: React.CSSProperties = {
    ...mono,
    fontSize: 13,
    padding: "5px 14px 5px 0",
    borderBottom: `1px solid ${T.line}44`,
    whiteSpace: "nowrap",
  };

  return (
    <div style={{ overflowX: "auto", marginTop: 10 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
        <thead>
          <tr>
            <th style={th}>{t.thDuration}</th>
            <th style={th}>{t.thBest}</th>
            <th style={th}>{t.thSource}</th>
            <th style={th}>{t.thActivity}</th>
          </tr>
        </thead>
        <tbody>
          {supports.map((s) => (
            <tr key={s.sec}>
              <td style={td}>{fmtTime(s.sec)}</td>
              <td style={{ ...td, color: T.gold }}>
                {isRide
                  ? `${Math.round(s.value)} W · ${(s.value / weight).toFixed(1)} W/kg`
                  : fmtPace(s.value)}
              </td>
              <td style={{ ...td, color: T.dim }}>{kindLabel[s.kind]}</td>
              <td style={{ ...td, whiteSpace: "normal" }}>
                {s.activity ? (
                  <a
                    href={`https://www.strava.com/activities/${s.activity.id}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: T.text, textDecoration: "none" }}
                    aria-label={t.openActivity(s.activity.name)}
                  >
                    {s.activity.name}{" "}
                    <span style={{ color: T.faint, fontSize: 11.5 }}>
                      {s.activity.date} ↗
                    </span>
                  </a>
                ) : (
                  <span style={{ color: T.faint }}>{t.ftpFromProfile}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
