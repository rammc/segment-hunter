import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Sport } from "./types";

/* ============================================================
   Leichtgewichtige i18n-Loesung ohne Fremdbibliothek: ein
   Woerterbuch je Sprache, ein Context mit Toggle, Persistenz
   im localStorage. Default folgt der Browser-Sprache.
   ============================================================ */

export type Lang = "de" | "en";

const de = {
  tagline: (sport: Sport): string =>
    sport === "ride"
      ? "KOM-Zeiten gegen deine Power-Kurve: sehen, wo der Angriff realistisch ist."
      : "CR-Zeiten gegen deine Pace-Kurve: sehen, wo der Angriff realistisch ist.",
  refresh: "↻ Aktualisieren",
  refreshing: "Aktualisiere …",

  /* Setup */
  setupTitle: "1 · Strava-Proxy verbinden",
  setupText:
    "Browser können die Strava-API nicht direkt aufrufen: Strava setzt auf oauth/token bewusst keine CORS-Header. Alle Daten laufen deshalb über deinen eigenen Cloudflare Worker, der Client-Secret und Refresh-Token serverseitig hält. Hier nur dessen URL eintragen.",
  proxyUrl: "Proxy-URL",
  proxyKey: "Proxy-Key (optional)",
  proxyKeyPlaceholder: "falls PROXY_KEY gesetzt",
  connect: "Verbinden & Analyse starten",

  /* Ladeschritte */
  stepHealth: "Prüfe Proxy-Verbindung …",
  stepAthlete: "Lade Athletenprofil …",
  stepActivities: "Lade Aktivitäten der letzten 8 Wochen …",
  stepAnalyze: (sport: Sport, from: number, to: number, total: number) =>
    `Analysiere ${sport === "ride" ? "Fahrten" : "Läufe"} ${from}-${to} von ${total} …`,
  stepCurve: (sport: Sport): string =>
    sport === "ride" ? "Berechne Power-Kurve …" : "Berechne Pace-Kurve …",
  stepKom: (label: string) => `Lade ${label}-Zeiten über den Proxy …`,

  /* Fehler */
  errProxyUnreachable: "Proxy nicht erreichbar. URL prüfen.",
  errNoRides: "Keine Radaktivitäten gefunden.",
  errNoRuns: "Keine Läufe gefunden.",
  errNoPower: "Keine Leistungsdaten gefunden. Ohne Watt-Werte kann nichts bewertet werden.",
  errNoRunEfforts: "Keine Lauf-Bestzeiten gefunden. Ohne Best Efforts kann nichts bewertet werden.",
  errUnknown: "Unbekannter Fehler",
  errLoadMore: "Nachladen fehlgeschlagen",
  errProxy401: "Proxy meldet 401: Proxy-Key prüfen.",
  errKomFetch: "Abruf der Bestzeiten über den Proxy fehlgeschlagen.",
  errAi: "AI-Analyse fehlgeschlagen: ",

  /* Athleten-Leiste */
  athlete: "Athlet",
  weight: "Gewicht",
  fiveMinPower: "5-min-Power",
  fiveMinPace: "5-min-Pace",
  segments: "Segmente",
  withinReach: (label: string) => `${label} in Reichweite`,
  komMode: (label: string) => `${label}-Modus:`,
  modeOn: "aktiv",
  modeOff: "aus",
  modeError: "Fehler",
  komFound: (found: number, checked: number, label: string) =>
    `${found} ${label}-Zeiten bei ${checked} geprüften Segmenten.`,

  /* Hunt-Liste */
  huntTitle: "Angriffsziele",
  aiButton: "AI-Taktikplan erstellen",
  aiBusy: "Analysiere …",
  aiPlanTitle: "Taktikplan",
  aiTarget: "→ Ziel",
  filterLength: "Länge",
  filterGrade: "Steigung",
  filterChance: "Chance",
  filterAll: "Alle",
  filterFlat: "Flach < 3 %",
  filterRolling: "Hügelig 3-6 %",
  filterClimb: "Anstieg ≥ 6 %",
  filterAttack: "In Reichweite",
  filterTrain: "Mind. machbar",
  filterCount: (shown: number, total: number) => `${shown} von ${total} Segmenten`,
  rank: (label: string, rank: number) => `${label}-Rang ${rank}`,
  prRank: (rank: number) => `PR-Rang ${rank}`,
  needHaveWatts: (need: number, have: number) => `benötigt ≈${need} W, du hast ${have} W`,
  needHavePace: (need: string, have: string) => `benötigt ${need}, du kannst ${have}`,
  reserve: (w: number) => `Reserve +${w} W`,
  lowQuality: "[geringe Datenqualität]",
  openOnStrava: (name: string) => `Segment ${name} auf Strava öffnen`,
  emptyFilter: "Kein Segment passt zu den Filtern. Filter lockern oder mehr laden.",
  loadMoreBusy: "Lade …",
  loadMore: (n: number) => `Mehr laden (${n} Aktivitäten übrig)`,
  loadMoreKom: "Weitere Bestzeiten laden",
  athletes: (n: number) => `${n} Athleten`,

  /* Badges */
  badgeKom: "DU HÄLTST DEN KOM",
  badgeAttack: "KOM IN REICHWEITE",
  badgeTrain: "MIT TRAINING MACHBAR",
  badgeFar: "AUSSER REICHWEITE",

  /* Sport-Toggle */
  sportRide: "Rad",
  sportRun: "Laufen",
  sportGroup: "Sportart",
  langGroup: "Sprache",

  /* Power-/Pace-Kurve */
  curveTitle: (sport: Sport): string =>
    sport === "ride"
      ? "Power-Kurve (Bestwerte der analysierten Fahrten)"
      : "Pace-Kurve (Best Efforts der analysierten Läufe)",
  curveAria: (sport: Sport): string => (sport === "ride" ? "Power-Kurve" : "Pace-Kurve"),

  /* Segmente in der Naehe */
  nearbyTitle: (label: string) => `${label} in deiner Nähe`,
  useLocation: "📍 Standort verwenden",
  searching: "Suche …",
  searchingRadius: "Suche Segmente im Umkreis von etwa 5 km …",
  errNoGeolocation: "Dieser Browser unterstützt keine Standortabfrage.",
  errGeoDenied: "Standortfreigabe abgelehnt. In den Browser-Einstellungen erlauben.",
  errGeoFailed: "Standort konnte nicht ermittelt werden.",
  errSearch: "Suche fehlgeschlagen.",
  nearbyEmpty: "Keine Segmente in der Nähe gefunden.",
  noAssessment: "[keine Bewertung möglich]",
  physicsNote: (weight: number) =>
    `Bewertung über Physikmodell (Roll- und Luftwiderstand, Steigung, ${weight} kg plus 9 kg Rad). Ohne eigenen Effort ist das eine grobe Schätzung, besonders im Flachen.`,

  /* Trainingsplan */
  planTitle: "Trainingsplan",
  planIntro: (sport: Sport) =>
    `Racedate, Strecke und Zielzeit angeben. Der Plan baut auf deinem Trainingsverhalten der letzten 8 Wochen auf (Einheiten pro Woche, Umfang, typische Trainingstage) und deiner ${sport === "ride" ? "Power" : "Pace"}-Kurve.`,
  raceDate: "Racedate",
  distanceKm: "Strecke (km)",
  targetTime: "Zielzeit",
  egDistance: (sport: Sport): string => (sport === "ride" ? "z. B. 120" : "z. B. 10"),
  egTime: (sport: Sport): string => (sport === "ride" ? "z. B. 3:30:00" : "z. B. 45:00"),
  createPlan: "Plan erstellen",
  creatingPlan: "Erstelle Plan …",
  planWait: "Der Coach plant deine Wochen, das dauert etwa eine halbe Minute …",
  deletePlan: "🗑 Plan löschen",
  deleteConfirm: "Wirklich löschen? Klick bestätigt.",
  errRaceDate: "Bitte ein Racedate in der Zukunft wählen.",
  errDistance: "Bitte eine Streckenlänge in km angeben.",
  errTargetTime: "Zielzeit bitte als mm:ss oder h:mm:ss angeben, z. B. 45:00 oder 3:30:00.",
  errPlanEmpty: "Der generierte Plan war leer. Bitte nochmal versuchen.",
  errPlanFailed: "Plan konnte nicht erstellt werden.",
  planSummary: (km: number, date: string, target: string) => `${km} km am ${date}, Ziel ${target}`,
  planProgress: (done: number, due: number, pct: string) =>
    `${done} von ${due} fälligen Einheiten absolviert${pct}`,
  planTotal: (n: number) => `${n} Einheiten gesamt`,
  weekdays: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
  typeInterval: "Intervalle",
  typeTempo: "Tempo",
  typeEndurance: "Grundlage",
  typeLong: "Lang",
  typeRecovery: "Locker",
  typeCross: "Alternativ (Rad/Lauf)",
  typeRace: "Rennen",
  doneReset: "✓ Erledigt (zurücksetzen)",
  markDone: "Als erledigt markieren",
  planFootnote: (sport: Sport) =>
    `Einheiten werden automatisch abgehakt, wenn an dem Tag eine passende ${sport === "ride" ? "Fahrt" : "Lauf"}-Aktivität mit mindestens der halben geplanten Dauer auf Strava liegt ("Aktualisieren" lädt neue Aktivitäten). Manuelles Abhaken übersteuert das. Plan und Fortschritt liegen nur in diesem Browser.`,

  /* Footer */
  footerRide:
    "Hunt-Score = Reserve deiner Power-Kurve auf der Segmentdauer (70 %) plus Rang-Bonus (30 %). KOM-Machbarkeit = Power-Kurve auf der KOM-Dauer geteilt durch benötigte Watt (Schätzung: P∝v bei Steigung ≥5 %, P∝v²·⁷ im Flachen, dazwischen geblendet; Wind, Aero-Position und Taktik sind nicht modelliert). Datenquellen: Segment-Efforts und Watt-Streams über den eigenen Proxy (Strava v3), KOM-Zeiten aus den Segmentdetails (xoms). Analysiert werden die härtesten und jüngsten Fahrten der letzten 8 Wochen; das FTP aus deinem Strava-Profil verankert die Kurve bei 20 und 60 Minuten.",
  footerRun:
    "Hunt-Score = Reserve deiner Pace-Kurve auf der Segmentdauer (70 %) plus Rang-Bonus (30 %). CR-Machbarkeit = deine interpolierte Geschwindigkeit auf der CR-Dauer geteilt durch die benötigte Geschwindigkeit (Distanz durch CR-Zeit). Steigung ist beim Laufen nicht modelliert; bergige Segmente werden daher überschätzt. Das lange Ende der Kurve wird per Riegel-Formel (Exponent 1,06) aus deinen besten Efforts zwischen 6 und 90 Minuten extrapoliert und zeigt damit Rennpotenzial statt Trainingstempo. Datenquellen: Best Efforts und Segment-Efforts über den eigenen Proxy (Strava v3), CR-Zeiten aus den Segmentdetails (xoms).",
};

export type Messages = typeof de;

const en: Messages = {
  tagline: (sport) =>
    sport === "ride"
      ? "KOM times against your power curve: see where an attack is realistic."
      : "CR times against your pace curve: see where an attack is realistic.",
  refresh: "↻ Refresh",
  refreshing: "Refreshing …",

  setupTitle: "1 · Connect Strava proxy",
  setupText:
    "Browsers cannot call the Strava API directly: Strava deliberately sends no CORS headers on oauth/token. All data therefore flows through your own Cloudflare Worker, which keeps the client secret and refresh token server-side. Just enter its URL here.",
  proxyUrl: "Proxy URL",
  proxyKey: "Proxy key (optional)",
  proxyKeyPlaceholder: "if PROXY_KEY is set",
  connect: "Connect & start analysis",

  stepHealth: "Checking proxy connection …",
  stepAthlete: "Loading athlete profile …",
  stepActivities: "Loading activities from the last 8 weeks …",
  stepAnalyze: (sport, from, to, total) =>
    `Analyzing ${sport === "ride" ? "rides" : "runs"} ${from}-${to} of ${total} …`,
  stepCurve: (sport) => (sport === "ride" ? "Computing power curve …" : "Computing pace curve …"),
  stepKom: (label) => `Loading ${label} times via the proxy …`,

  errProxyUnreachable: "Proxy unreachable. Check the URL.",
  errNoRides: "No rides found.",
  errNoRuns: "No runs found.",
  errNoPower: "No power data found. Without watt values nothing can be scored.",
  errNoRunEfforts: "No running best efforts found. Without best efforts nothing can be scored.",
  errUnknown: "Unknown error",
  errLoadMore: "Loading more failed",
  errProxy401: "Proxy returned 401: check the proxy key.",
  errKomFetch: "Fetching best times via the proxy failed.",
  errAi: "AI analysis failed: ",

  athlete: "Athlete",
  weight: "Weight",
  fiveMinPower: "5 min power",
  fiveMinPace: "5 min pace",
  segments: "Segments",
  withinReach: (label) => `${label} within reach`,
  komMode: (label) => `${label} mode:`,
  modeOn: "on",
  modeOff: "off",
  modeError: "error",
  komFound: (found, checked, label) =>
    `${found} ${label} times across ${checked} checked segments.`,

  huntTitle: "Attack targets",
  aiButton: "Generate AI tactics plan",
  aiBusy: "Analyzing …",
  aiPlanTitle: "Tactics plan",
  aiTarget: "→ target",
  filterLength: "Length",
  filterGrade: "Gradient",
  filterChance: "Chance",
  filterAll: "All",
  filterFlat: "Flat < 3 %",
  filterRolling: "Rolling 3-6 %",
  filterClimb: "Climb ≥ 6 %",
  filterAttack: "Within reach",
  filterTrain: "At least trainable",
  filterCount: (shown, total) => `${shown} of ${total} segments`,
  rank: (label, rank) => `${label} rank ${rank}`,
  prRank: (rank) => `PR rank ${rank}`,
  needHaveWatts: (need, have) => `needs ≈${need} W, you have ${have} W`,
  needHavePace: (need, have) => `needs ${need}, you can do ${have}`,
  reserve: (w) => `reserve +${w} W`,
  lowQuality: "[low data quality]",
  openOnStrava: (name) => `Open segment ${name} on Strava`,
  emptyFilter: "No segment matches the filters. Relax the filters or load more.",
  loadMoreBusy: "Loading …",
  loadMore: (n) => `Load more (${n} activities left)`,
  loadMoreKom: "Load more best times",
  athletes: (n) => `${n} athletes`,

  badgeKom: "YOU HOLD THE KOM",
  badgeAttack: "KOM WITHIN REACH",
  badgeTrain: "TRAINABLE",
  badgeFar: "OUT OF REACH",

  sportRide: "Ride",
  sportRun: "Run",
  sportGroup: "Sport",
  langGroup: "Language",

  curveTitle: (sport) =>
    sport === "ride"
      ? "Power curve (best values from the analyzed rides)"
      : "Pace curve (best efforts from the analyzed runs)",
  curveAria: (sport) => (sport === "ride" ? "Power curve" : "Pace curve"),

  nearbyTitle: (label) => `${label}s near you`,
  useLocation: "📍 Use my location",
  searching: "Searching …",
  searchingRadius: "Searching segments within about 5 km …",
  errNoGeolocation: "This browser does not support geolocation.",
  errGeoDenied: "Location access denied. Allow it in your browser settings.",
  errGeoFailed: "Could not determine your location.",
  errSearch: "Search failed.",
  nearbyEmpty: "No segments found nearby.",
  noAssessment: "[no assessment possible]",
  physicsNote: (weight) =>
    `Assessment via physics model (rolling and air resistance, gradient, ${weight} kg plus 9 kg bike). Without your own effort this is a rough estimate, especially on flat segments.`,

  planTitle: "Training plan",
  planIntro: (sport) =>
    `Enter race date, distance and target time. The plan builds on your training behavior of the last 8 weeks (sessions per week, volume, typical training days) and your ${sport === "ride" ? "power" : "pace"} curve.`,
  raceDate: "Race date",
  distanceKm: "Distance (km)",
  targetTime: "Target time",
  egDistance: (sport) => (sport === "ride" ? "e.g. 120" : "e.g. 10"),
  egTime: (sport) => (sport === "ride" ? "e.g. 3:30:00" : "e.g. 45:00"),
  createPlan: "Create plan",
  creatingPlan: "Creating plan …",
  planWait: "The coach is planning your weeks, this takes about half a minute …",
  deletePlan: "🗑 Delete plan",
  deleteConfirm: "Really delete? Click to confirm.",
  errRaceDate: "Please pick a race date in the future.",
  errDistance: "Please enter a distance in km.",
  errTargetTime: "Please enter the target time as mm:ss or h:mm:ss, e.g. 45:00 or 3:30:00.",
  errPlanEmpty: "The generated plan was empty. Please try again.",
  errPlanFailed: "Could not create the plan.",
  planSummary: (km, date, target) => `${km} km on ${date}, target ${target}`,
  planProgress: (done, due, pct) => `${done} of ${due} due workouts completed${pct}`,
  planTotal: (n) => `${n} workouts total`,
  weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  typeInterval: "Intervals",
  typeTempo: "Tempo",
  typeEndurance: "Endurance",
  typeLong: "Long",
  typeRecovery: "Easy",
  typeCross: "Cross (ride/run)",
  typeRace: "Race",
  doneReset: "✓ Done (reset)",
  markDone: "Mark as done",
  planFootnote: (sport) =>
    `Workouts are checked off automatically when a matching ${sport === "ride" ? "ride" : "run"} activity with at least half the planned duration exists on Strava that day ("Refresh" loads new activities). Manual check-off overrides this. Plan and progress live only in this browser.`,

  footerRide:
    "Hunt score = reserve of your power curve at the segment duration (70 %) plus rank bonus (30 %). KOM feasibility = power curve at the KOM duration divided by required watts (estimate: P∝v on gradients ≥5 %, P∝v²·⁷ on flat, blended in between; wind, aero position and tactics are not modeled). Data sources: segment efforts and watt streams via your own proxy (Strava v3), KOM times from the segment details (xoms). Analyzed are the hardest and most recent rides of the last 8 weeks; the FTP from your Strava profile anchors the curve at 20 and 60 minutes.",
  footerRun:
    "Hunt score = reserve of your pace curve at the segment duration (70 %) plus rank bonus (30 %). CR feasibility = your interpolated speed at the CR duration divided by the required speed (distance divided by CR time). Gradient is not modeled for running; hilly segments are therefore overestimated. The long end of the curve is extrapolated via the Riegel formula (exponent 1.06) from your best efforts between 6 and 90 minutes and thus shows race potential instead of training pace. Data sources: best efforts and segment efforts via your own proxy (Strava v3), CR times from the segment details (xoms).",
};

const DICTS: Record<Lang, Messages> = { de, en };
const STORAGE_KEY = "sh:lang";

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "de" || stored === "en") return stored;
  } catch {
    // Storage nicht verfuegbar
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("de")
    ? "de"
    : "en";
}

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Messages;
}

const I18nContext = createContext<I18nValue>({ lang: "de", setLang: () => {}, t: de });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  function setLang(l: Lang) {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Storage nicht verfuegbar: Toggle gilt dann nur fuer die Sitzung
    }
  }

  return (
    <I18nContext.Provider value={{ lang, setLang, t: DICTS[lang] }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
