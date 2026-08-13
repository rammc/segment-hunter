# Segment Hunter

[English](README.md) · **Deutsch**

**KOM-Zeiten gegen deine Power-Kurve: sehen, wo der Angriff realistisch ist.**

Segment Hunter analysiert deine Strava-Aktivitaeten und identifiziert Segmente,
auf denen ein KOM-Angriff realistisch ist. Basis ist deine eigene Leistung:
aus den Watt-Streams deiner Fahrten wird eine Power-Kurve berechnet und gegen
die KOM-Zeiten der gefahrenen Segmente gehalten.

Live: [rammc.github.io/segment-hunter](https://rammc.github.io/segment-hunter/)

Die UI selbst ist zweisprachig: ein DE/EN-Toggle im Kopfbereich wechselt die
Sprache, die Wahl wird im Browser gemerkt.

---

## Inhaltsverzeichnis

- [Architektur](#architektur)
- [Fachlogik](#fachlogik)
- [Repo-Struktur](#repo-struktur)
- [Setup](#setup)
  - [1. Strava-API-App anlegen](#1-strava-api-app-anlegen)
  - [2. Worker deployen](#2-worker-deployen)
  - [3. Frontend lokal starten](#3-frontend-lokal-starten)
- [Deployment](#deployment)
- [Trainingsplan Builder](#trainingsplan-builder)
- [Optional: AI-Taktikplan](#optional-ai-taktikplan)
- [Entwicklung](#entwicklung)
- [Grenzen des Modells](#grenzen-des-modells)

---

## Architektur

Statisches React-Frontend auf GitHub Pages, ein Cloudflare Worker als einzige
Server-Komponente. Alle Strava-Secrets bleiben im Worker, der Browser kennt
nur die Proxy-URL.

```
Browser (React, GitHub Pages)
   |
   |  fetch (CORS, optional x-proxy-key)
   v
Cloudflare Worker (strava-kom-proxy)
   |  haelt Client-Secret + Refresh-Token,
   |  erneuert Access Tokens selbst
   +--> Strava v3 API   (Aktivitaeten, Efforts, Streams, Segmente)
   +--> Anthropic API   (optional, POST /coach)
```

Warum ein Proxy? Browser koennen die Strava-API nicht direkt aufrufen:
Strava setzt auf `oauth/token` bewusst keine CORS-Header. Ausserdem gehoeren
Client-Secret und Refresh-Token nicht in den Client.

### Worker-Routen

| Route | Zweck |
| --- | --- |
| `GET /health` | Erreichbarkeit, meldet ob `/coach` konfiguriert ist |
| `GET /athlete` | Profil (Name, Gewicht) |
| `GET /athlete/activities` | Aktivitaetenliste (`per_page`, `page`) |
| `GET /activities/:id` | Aktivitaet inkl. aller Segment-Efforts |
| `GET /activities/:id/streams` | Watt- und Zeit-Streams fuer die Power-Kurve |
| `GET /segments/:id` | Segmentdetails (`xoms` = KOM-Zeit, `athlete_count`) |
| `POST /coach` | AI-Taktikplan ueber die Anthropic API (optional) |
| `POST /trainingplan` | Trainingsplan bis zum Racedate ueber die Anthropic API (optional) |

## Fachlogik

Der fachliche Kern liegt in [`frontend/src/lib/scoring.ts`](frontend/src/lib/scoring.ts)
und ist mit Vitest getestet.

- **Power-Kurve**: beste Durchschnittsleistung ueber Standard-Dauern
  (5 s bis 1 h), berechnet per Sliding Window ueber die Watt-Streams der
  letzten Fahrten. Segment-Efforts dienen als Fallback, wenn kein
  Powermeter-Stream vorliegt. Zwischen Stuetzstellen wird logarithmisch
  interpoliert (`curveAt`).
- **Hunt-Score**: 70 % Leistungsreserve auf der Segmentdauer
  (Kurvenwert minus gefahrene Watt, gedeckelt bei 60 %) plus 30 % Rang-Bonus.
- **KOM-Machbarkeit**: benoetigte Watt fuer die KOM-Zeit ueber ein
  Steigungsmodell (P proportional v bei Steigung >= 5 %, v^2.7 im Flachen,
  dazwischen linear geblendet), verglichen mit der Power-Kurve auf der
  KOM-Dauer.
- **Badges**: KOM gehalten / in Reichweite (ratio >= 0.97) /
  mit Training machbar (0.85 bis 0.97) / ausser Reichweite.
- **Datenqualitaet**: Efforts mit Watt < 30 oder Dauer < 30 s werden als
  geringe Datenqualitaet markiert und nicht gescored.
- **Kurven-Grafik**: dargestellt wird die auf Eckpunkte ausgeduennte Kurve
  (`displayCurve`), Marker nur auf den Standard-Dauern. Durchgezogen heisst
  aus Watt-Streams gemessen, gestrichelt heisst geschaetzt (Effort-Fallback/
  FTP-Anker beim Rad, Riegel-Extrapolation beim Laufen). KOM-/CR-Ziele
  liegen als Punkte ueber der Kurve (gold = in Reichweite), und eine
  Stuetzpunkt-Tabelle unter der Grafik verlinkt jeden Bestwert auf die
  Strava-Aktivitaet, aus der er stammt (`curveSupports`/`speedSupports`).

## Repo-Struktur

```
segment-hunter/
  frontend/              Vite + React + TypeScript
    src/
      lib/strava.ts      Worker-Client
      lib/scoring.ts     Fachlogik (huntScore, komFeasibility, curveAt, ...)
      lib/scoring.test.ts
      lib/i18n.tsx       DE/EN-Woerterbuch + Sprach-Toggle-Context
      components/        UI-Bausteine (ScoreDial, KomBadge, PowerCurve, ...)
      App.tsx            Ladefluss und Hunt-Liste
  worker/                Cloudflare Worker (Strava-Proxy + /coach)
    src/index.ts
    wrangler.toml
  docs/
    HOWTO-wrangler.de.md Schritt-fuer-Schritt-Anleitung wrangler (DE + EN)
  reference/             Prototyp-Dateien (Claude-Artifact), unveraendert
  .github/workflows/
    deploy-pages.yml     Frontend-Build auf GitHub Pages
    deploy-worker.yml    wrangler deploy bei Aenderungen unter worker/
```

## Setup

### 1. Strava-API-App anlegen

1. Unter [strava.com/settings/api](https://www.strava.com/settings/api) eine
   App anlegen. `Client ID` und `Client Secret` notieren.
2. Einen Refresh-Token mit Scope `activity:read` (fuer private Aktivitaeten
   `activity:read_all`) und `profile:read_all` holen, z. B. ueber den
   OAuth-Flow:
   - Browser: `https://www.strava.com/oauth/authorize?client_id=<ID>&response_type=code&redirect_uri=http://localhost&scope=activity:read_all,profile:read_all`
   - Den `code` aus der Redirect-URL gegen Tokens tauschen:
     `curl -X POST https://www.strava.com/oauth/token -d client_id=<ID> -d client_secret=<SECRET> -d code=<CODE> -d grant_type=authorization_code`
   - Der `refresh_token` aus der Antwort ist das Worker-Secret.

### 2. Worker deployen

Ausfuehrliche Anleitung: [docs/HOWTO-wrangler.de.md](docs/HOWTO-wrangler.de.md)

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put STRAVA_REFRESH_TOKEN
npx wrangler secret put PROXY_KEY          # optional, empfohlen
npx wrangler secret put ANTHROPIC_API_KEY  # optional, nur fuer /coach
```

Danach ist der Proxy unter `https://strava-kom-proxy.<account>.workers.dev`
erreichbar. Kurztest:

```bash
curl -H "x-proxy-key: <KEY>" https://strava-kom-proxy.<account>.workers.dev/health
# -> {"ok":true,"coach":false}
```

### 3. Frontend lokal starten

```bash
cd frontend
npm install
cp .env.example .env    # VITE_PROXY_URL eintragen
npm run dev
```

Im Setup-Screen die Proxy-URL (vorausgefuellt aus `VITE_PROXY_URL`) und den
Proxy-Key eintragen, dann "Verbinden & Analyse starten".

## Deployment

Beide Deployments laufen ueber GitHub Actions:

| Workflow | Trigger | Ziel |
| --- | --- | --- |
| `deploy-pages.yml` | Push auf `main` unter `frontend/` | GitHub Pages |
| `deploy-worker.yml` | Push auf `main` unter `worker/` | Cloudflare Worker |

Einmalig im Repo konfigurieren:

1. **Settings -> Pages**: Source auf "GitHub Actions" stellen. Die Seite
   laeuft eigenstaendig unter `https://rammc.github.io/segment-hunter/`
   (Vite-Base `/segment-hunter/`). Fuer eine spaetere Custom Domain: Domain
   in den Pages-Settings eintragen und den Build mit `VITE_BASE=/` fahren.
2. **Settings -> Secrets and variables -> Actions**:
   - Secret `CLOUDFLARE_API_TOKEN` (Cloudflare API Token mit
     "Edit Workers"-Rechten)
   - Variable `VITE_PROXY_URL` (die Worker-URL, kein Secret)

Die Worker-Secrets (Strava, Anthropic) leben in Cloudflare und werden von
`wrangler deploy` nicht angefasst.

## Trainingsplan Builder

Racedate, Streckenlaenge und Zielzeit eingeben; der Plan wird ueber
`POST /trainingplan` generiert und baut auf dem echten Trainingsverhalten der
letzten 8 Wochen auf (Einheiten pro Woche, Umfang, laengste Einheit, typische
Trainingstage) sowie FTP und Power- bzw. Pace-Kurve. Angezeigt wird er als
Wochenkalender (Mo bis So) mit Einheiten-Typen (Intervalle, Tempo, Grundlage,
lange Einheit, locker, Rennen). Fortschritt wird automatisch gegen Strava
gematcht: eine geplante Einheit gilt als absolviert, wenn am selben Tag eine
passende Aktivitaet mit mindestens der halben Dauer existiert; manuelles
Abhaken uebersteuert das. Plan und Fortschritt liegen im localStorage des
Browsers, es gibt bewusst kein Backend ausser dem Worker.

## Optional: AI-Taktikplan

`POST /coach` ruft die Anthropic API serverseitig auf (Modell
`claude-sonnet-4-6`) und liefert fuer die Top-Segmente einen kurzen
Taktikplan (Begruendung, Pacing, Zielwatt). Das Feature ist komplett
optional: ohne `ANTHROPIC_API_KEY` meldet `/health` `coach: false` und das
Frontend blendet den Button aus. Alles andere funktioniert unveraendert.
Beide AI-Endpunkte beachten die UI-Sprache: das Frontend sendet
`lang: "de" | "en"` und der Plan wird in dieser Sprache generiert.

## Entwicklung

```bash
cd frontend && npm test           # Vitest fuer die Fachlogik
cd frontend && npm run build      # Typecheck + Produktionsbuild
cd worker   && npm run typecheck  # Worker-Typecheck
cd worker   && npm run dev        # wrangler dev (Secrets in worker/.dev.vars)
```

Fuer `wrangler dev` eine Datei `worker/.dev.vars` anlegen (gitignored):

```
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
STRAVA_REFRESH_TOKEN=...
PROXY_KEY=...
```

## Grenzen des Modells

- Das Steigungsmodell schaetzt benoetigte Watt nur grob: Wind, Aero-Position,
  Gewicht des KOM-Halters und Taktik (Windschatten!) sind nicht modelliert.
- Ohne Powermeter basiert die Kurve auf Stravas geschaetzten Watt und den
  Effort-Durchschnitten; die Aussagekraft sinkt entsprechend.
- Analysiert werden die letzten Fahrten (Standard: 8). Die Power-Kurve ist
  also eine Momentaufnahme, keine Saisonbestleistung.
- Laufen wird ueber Best Efforts und eine Pace-Kurve unterstuetzt (CR-Zeiten
  statt KOM-Watt). Steigung ist beim Laufen nicht modelliert, bergige
  Segmente werden daher ueberschaetzt.
