# Segment Hunter

Strava-Segment-Analyse: identifiziert potenzielle KOMs auf Basis der eigenen
Leistung. Statisches React-Frontend auf GitHub Pages, Cloudflare Worker als
einzige Server-Komponente.

## Architektur

- `frontend/` Vite + React + TypeScript. Laedt alle Strava-Daten ueber den
  Worker (`src/lib/strava.ts`), bewertet Segmente (`src/lib/scoring.ts`)
  und rendert die Hunt-Liste im Head-Unit-Stil.
- `worker/` Cloudflare Worker (TypeScript). Allgemeiner Strava-Proxy mit
  Token-Refresh und CORS. Routen: `/health`, `/athlete`,
  `/athlete/activities`, `/activities/:id`, `/activities/:id/streams`,
  `/segments/:id`, `POST /coach` (Anthropic API, optional).
- `reference/` die beiden Prototyp-Dateien, unveraendert. Nur Referenz,
  wird nicht gebaut.

## Wichtige Architektur-Entscheidungen

- Der Prototyp holte Daten ueber Anthropic-API + Strava-MCP (funktioniert
  nur in Claude.ai). Hier laeuft alles deterministisch ueber den Worker.
- Die Strava v3 API liefert fuer Radfahrten keine Power-Bestwerte. Die
  Power-Kurve wird deshalb aus den Watt-Streams berechnet
  (`maxAvgPower`, Sliding Window) mit Segment-Efforts als Fallback
  (`buildPowerCurve`).
- Der Worker heisst weiterhin `strava-kom-proxy` (wrangler.toml), damit
  `wrangler deploy` den bestehenden Worker samt Secrets aktualisiert.
- `/coach` ruft die Anthropic API serverseitig auf (Modell
  claude-sonnet-4-6, kein Prefill, robustes JSON-Parsing). Das Frontend
  blendet den Button nur ein, wenn `/health` `coach: true` meldet.

## Konventionen

- TypeScript in Frontend und Worker, strict.
- Vitest-Tests fuer `scoring.ts` (die Formeln sind der fachliche Kern).
  Bei Aenderungen an der Fachlogik zuerst Tests anpassen.
- Frontend-Konfiguration (Proxy-URL) ueber `VITE_PROXY_URL`, kein Secret
  im Client.
- Keine Em-Dashes in Texten und UI-Copy.
- UI-Sprache Deutsch, Design-Tokens aus `frontend/src/theme.ts`.

## Secrets (nie ins Repo)

- Worker: `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`,
  `STRAVA_REFRESH_TOKEN`, `PROXY_KEY` (empfohlen),
  optional `ANTHROPIC_API_KEY`.
- GitHub Actions: `CLOUDFLARE_API_TOKEN` als Repository-Secret,
  `VITE_PROXY_URL` als Repository-Variable.

## Befehle

```
cd frontend && npm run dev        # Frontend lokal
cd frontend && npm test           # Vitest (scoring)
cd frontend && npm run build      # Typecheck + Build
cd worker && npm run dev          # wrangler dev (braucht .dev.vars)
cd worker && npm run typecheck
cd worker && npm run deploy       # wrangler deploy
```

Lokale Worker-Secrets fuer `wrangler dev`: `worker/.dev.vars`
(gitignored) mit `STRAVA_CLIENT_ID=...` usw.
