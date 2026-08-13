# Segment Hunter

**English** · [Deutsch](README.de.md)

**KOM times against your power curve: see where an attack is realistic.**

Segment Hunter analyzes your Strava activities and identifies segments where
a KOM attack is realistic. The basis is your own performance: a power curve
is computed from the watt streams of your rides and compared against the KOM
times of the segments you have ridden.

Live: [rammc.github.io/segment-hunter](https://rammc.github.io/segment-hunter/)

The UI itself is bilingual: a DE/EN toggle in the header switches the
language, the choice is remembered in the browser.

---

## Table of contents

- [Architecture](#architecture)
- [Domain logic](#domain-logic)
- [Repo structure](#repo-structure)
- [Setup](#setup)
  - [1. Create a Strava API app](#1-create-a-strava-api-app)
  - [2. Deploy the worker](#2-deploy-the-worker)
  - [3. Run the frontend locally](#3-run-the-frontend-locally)
- [Deployment](#deployment)
- [Training plan builder](#training-plan-builder)
- [Optional: AI tactics plan](#optional-ai-tactics-plan)
- [Development](#development)
- [Limits of the model](#limits-of-the-model)

---

## Architecture

A static React frontend on GitHub Pages, one Cloudflare Worker as the only
server component. All Strava secrets stay in the worker, the browser only
knows the proxy URL.

```
Browser (React, GitHub Pages)
   |
   |  fetch (CORS, optional x-proxy-key)
   v
Cloudflare Worker (strava-kom-proxy)
   |  holds client secret + refresh token,
   |  renews access tokens itself
   +--> Strava v3 API   (activities, efforts, streams, segments)
   +--> Anthropic API   (optional, POST /coach)
```

Why a proxy? Browsers cannot call the Strava API directly: Strava
deliberately sends no CORS headers on `oauth/token`. Besides, the client
secret and refresh token do not belong in the client.

### Worker routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Reachability, reports whether `/coach` is configured |
| `GET /athlete` | Profile (name, weight) |
| `GET /athlete/activities` | Activity list (`per_page`, `page`) |
| `GET /activities/:id` | Activity including all segment efforts |
| `GET /activities/:id/streams` | Watt and time streams for the power curve |
| `GET /segments/:id` | Segment details (`xoms` = KOM time, `athlete_count`) |
| `POST /coach` | AI tactics plan via the Anthropic API (optional) |
| `POST /trainingplan` | Training plan up to race day via the Anthropic API (optional) |

## Domain logic

The core logic lives in [`frontend/src/lib/scoring.ts`](frontend/src/lib/scoring.ts)
and is covered by Vitest.

- **Power curve**: best average power over standard durations
  (5 s to 1 h), computed via sliding window over the watt streams of the
  most recent rides. Segment efforts serve as fallback when no power meter
  stream is available. Between anchor points the curve is interpolated
  logarithmically (`curveAt`).
- **Hunt score**: 70 % power reserve at the segment duration
  (curve value minus ridden watts, capped at 60 %) plus 30 % rank bonus.
- **KOM feasibility**: watts required for the KOM time via a gradient model
  (P proportional to v on gradients >= 5 %, v^2.7 on flat, blended linearly
  in between), compared with the power curve at the KOM duration.
- **Badges**: KOM held / within reach (ratio >= 0.97) /
  trainable (0.85 to 0.97) / out of reach.
- **Data quality**: efforts with watts < 30 or duration < 30 s are flagged
  as low data quality and not scored.
- **Curve chart**: the displayed curve is thinned to its corner points
  (`displayCurve`), with markers only on the standard durations. Solid means
  measured from watt streams, dashed means estimated (effort fallback/FTP
  anchor for rides, Riegel extrapolation for runs). KOM/CR targets are
  overlaid as dots (gold = within reach) and a support table below the
  chart links each best value to the Strava activity it came from
  (`curveSupports`/`speedSupports`).

## Repo structure

```
segment-hunter/
  frontend/              Vite + React + TypeScript
    src/
      lib/strava.ts      Worker client
      lib/scoring.ts     Domain logic (huntScore, komFeasibility, curveAt, ...)
      lib/scoring.test.ts
      lib/i18n.tsx       DE/EN dictionary + language toggle context
      components/        UI building blocks (ScoreDial, KomBadge, PowerCurve, ...)
      App.tsx            Loading flow and hunt list
  worker/                Cloudflare Worker (Strava proxy + /coach)
    src/index.ts
    wrangler.toml
  docs/
    HOWTO-wrangler.md    Step-by-step wrangler setup (EN, German available)
  reference/             Prototype files (Claude artifact), unchanged
  .github/workflows/
    deploy-pages.yml     Frontend build on GitHub Pages
    deploy-worker.yml    wrangler deploy on changes under worker/
```

## Setup

### 1. Create a Strava API app

1. Create an app at [strava.com/settings/api](https://www.strava.com/settings/api).
   Note down `Client ID` and `Client Secret`.
2. Obtain a refresh token with scope `activity:read` (for private activities
   `activity:read_all`) and `profile:read_all`, e.g. via the OAuth flow:
   - Browser: `https://www.strava.com/oauth/authorize?client_id=<ID>&response_type=code&redirect_uri=http://localhost&scope=activity:read_all,profile:read_all`
   - Exchange the `code` from the redirect URL for tokens:
     `curl -X POST https://www.strava.com/oauth/token -d client_id=<ID> -d client_secret=<SECRET> -d code=<CODE> -d grant_type=authorization_code`
   - The `refresh_token` from the response is the worker secret.

### 2. Deploy the worker

Detailed walkthrough: [docs/HOWTO-wrangler.md](docs/HOWTO-wrangler.md)

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put STRAVA_REFRESH_TOKEN
npx wrangler secret put PROXY_KEY          # optional, recommended
npx wrangler secret put ANTHROPIC_API_KEY  # optional, only for /coach
```

The proxy is then reachable at `https://strava-kom-proxy.<account>.workers.dev`.
Quick test:

```bash
curl -H "x-proxy-key: <KEY>" https://strava-kom-proxy.<account>.workers.dev/health
# -> {"ok":true,"coach":false}
```

### 3. Run the frontend locally

```bash
cd frontend
npm install
cp .env.example .env    # set VITE_PROXY_URL
npm run dev
```

On the setup screen, enter the proxy URL (prefilled from `VITE_PROXY_URL`)
and the proxy key, then hit "Connect & start analysis".

## Deployment

Both deployments run via GitHub Actions:

| Workflow | Trigger | Target |
| --- | --- | --- |
| `deploy-pages.yml` | Push to `main` under `frontend/` | GitHub Pages |
| `deploy-worker.yml` | Push to `main` under `worker/` | Cloudflare Worker |

One-time repo configuration:

1. **Settings -> Pages**: set Source to "GitHub Actions". The site runs
   standalone at `https://rammc.github.io/segment-hunter/`
   (Vite base `/segment-hunter/`). For a later custom domain: enter the
   domain in the Pages settings and build with `VITE_BASE=/`.
2. **Settings -> Secrets and variables -> Actions**:
   - Secret `CLOUDFLARE_API_TOKEN` (Cloudflare API token with
     "Edit Workers" rights)
   - Variable `VITE_PROXY_URL` (the worker URL, not a secret)

The worker secrets (Strava, Anthropic) live in Cloudflare and are not
touched by `wrangler deploy`.

## Training plan builder

Enter race date, distance and target time; the plan is generated via
`POST /trainingplan` and builds on your actual training behavior of the
last 8 weeks (sessions per week, volume, longest session, typical training
days) plus FTP and power or pace curve. It is displayed as a weekly
calendar (Mon to Sun) with workout types (intervals, tempo, endurance,
long, easy, race). Progress is matched against Strava automatically: a
planned workout counts as done when a matching activity with at least half
the duration exists on the same day; manual check-off overrides this. Plan
and progress live in the browser's localStorage, deliberately no backend
besides the worker.

## Optional: AI tactics plan

`POST /coach` calls the Anthropic API server-side (model
`claude-sonnet-4-6`) and returns a short tactics plan for the top segments
(reasoning, pacing, target watts). The feature is fully optional: without
`ANTHROPIC_API_KEY`, `/health` reports `coach: false` and the frontend
hides the button. Everything else works unchanged. Both AI endpoints
respect the UI language: the frontend sends `lang: "de" | "en"` and the
plan is generated in that language.

## Development

```bash
cd frontend && npm test           # Vitest for the domain logic
cd frontend && npm run build      # typecheck + production build
cd worker   && npm run typecheck  # worker typecheck
cd worker   && npm run dev        # wrangler dev (secrets in worker/.dev.vars)
```

For `wrangler dev` create a file `worker/.dev.vars` (gitignored):

```
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
STRAVA_REFRESH_TOKEN=...
PROXY_KEY=...
```

## Limits of the model

- The gradient model only roughly estimates required watts: wind, aero
  position, the KOM holder's weight and tactics (drafting!) are not modeled.
- Without a power meter the curve is based on Strava's estimated watts and
  the effort averages; the significance drops accordingly.
- Analyzed are the most recent rides (default: 8). The power curve is a
  snapshot, not a season's best.
- Running is supported via best efforts and a pace curve (CR times instead
  of KOM watts). Gradient is not modeled for running, so hilly segments are
  overestimated.
