# How-To: Wrangler setup for the Strava proxy worker

**English** · [Deutsch](HOWTO-wrangler.de.md)

This guide walks through deploying the Cloudflare Worker
(`worker/`, deployed as `strava-kom-proxy`) with wrangler: from a fresh
Cloudflare account to a reachable proxy with all secrets in place, plus
local development and CI deployment.

## What is wrangler?

[Wrangler](https://developers.cloudflare.com/workers/wrangler/) is
Cloudflare's CLI for Workers. It bundles the TypeScript source, uploads it,
manages secrets and runs a local dev server. It is a dev dependency of
`worker/package.json`, so `npx wrangler` always uses the pinned version;
no global install needed.

## Prerequisites

- Node.js 18+ (CI uses 22)
- A Cloudflare account, the free tier is enough (100k requests/day)
- The Strava credentials from step 1 of the [README setup](../README.md#setup):
  client ID, client secret, refresh token

## 1. One-time: login

```bash
cd worker
npm install
npx wrangler login
```

`wrangler login` opens the browser for an OAuth flow and stores an API
token locally. On a headless machine use `CLOUDFLARE_API_TOKEN=<token>`
as an environment variable instead.

## 2. First deploy

```bash
npx wrangler deploy
```

Wrangler reads [`wrangler.toml`](../worker/wrangler.toml):

```toml
name = "strava-kom-proxy"
main = "src/index.ts"
compatibility_date = "2026-08-01"
```

Important: the `name` is the worker's identity. Keep it as
`strava-kom-proxy`, so every deploy updates the existing worker in place
and its secrets and URL survive. Renaming it would create a second, empty
worker without secrets.

The output shows the public URL:

```
https://strava-kom-proxy.<account>.workers.dev
```

## 3. Set secrets

Secrets live in Cloudflare, never in the repo. Each `secret put` prompts
for the value on stdin:

```bash
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put STRAVA_REFRESH_TOKEN
npx wrangler secret put PROXY_KEY          # optional, recommended
npx wrangler secret put ANTHROPIC_API_KEY  # optional, only for /coach + /trainingplan
```

| Secret | Purpose | Required |
| --- | --- | --- |
| `STRAVA_CLIENT_ID` | Strava API app ID | yes |
| `STRAVA_CLIENT_SECRET` | Strava API app secret | yes |
| `STRAVA_REFRESH_TOKEN` | Token the worker uses to mint access tokens | yes |
| `PROXY_KEY` | Shared secret; requests must send it as `x-proxy-key` header | no, but recommended (otherwise the proxy is open to anyone who knows the URL) |
| `ANTHROPIC_API_KEY` | Enables `POST /coach` and `POST /trainingplan` | no |

`wrangler secret list` shows which secrets are set (names only, never
values). Setting a secret takes effect immediately, no redeploy needed.

## 4. Verify

```bash
curl -H "x-proxy-key: <KEY>" https://strava-kom-proxy.<account>.workers.dev/health
# -> {"ok":true,"coach":false}
```

`coach` flips to `true` once `ANTHROPIC_API_KEY` is set. A `401` means the
`x-proxy-key` header does not match `PROXY_KEY`. Then check a real Strava
route:

```bash
curl -H "x-proxy-key: <KEY>" "https://strava-kom-proxy.<account>.workers.dev/athlete"
```

If this returns your profile, the token refresh works and the setup is
complete. Enter the worker URL (and the proxy key) in the app's setup
screen.

## 5. Local development

`wrangler dev` runs the worker locally with the same runtime
(workerd). Local secrets come from `worker/.dev.vars` (gitignored):

```
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
STRAVA_REFRESH_TOKEN=...
PROXY_KEY=...
```

```bash
cd worker
npm run dev        # wrangler dev, default http://localhost:8787
```

Point the frontend's `VITE_PROXY_URL` (or the setup screen) at
`http://localhost:8787` to test the full stack locally.

## 6. CI deployment via GitHub Actions

[`deploy-worker.yml`](../.github/workflows/deploy-worker.yml) deploys on
every push to `main` that touches `worker/`. It runs `npm ci`,
`npm run typecheck` and then `cloudflare/wrangler-action@v3` with the
repository secret `CLOUDFLARE_API_TOKEN`.

Create that token in the Cloudflare dashboard: My Profile -> API Tokens ->
Create Token -> template "Edit Cloudflare Workers". Store it in the GitHub
repo under Settings -> Secrets and variables -> Actions as
`CLOUDFLARE_API_TOKEN`.

CI only deploys code. The worker secrets set in step 3 are untouched by
deploys, so they are configured exactly once.

## Troubleshooting

- **`Authentication error [code: 10000]`**: the API token is missing rights
  or expired. Recreate it with the "Edit Cloudflare Workers" template.
- **`/health` unreachable after deploy**: check `wrangler deployments list`;
  the `workers.dev` subdomain must be enabled for the account
  (dashboard -> Workers -> your worker -> Settings -> Domains & Routes).
- **`401 unauthorized` from every route**: `PROXY_KEY` is set but the
  request has no matching `x-proxy-key` header.
- **`429` responses**: Strava rate limit (100 requests per 15 minutes on
  the free API tier). The app surfaces this with the next reset time.
- **Secrets gone after deploy**: only happens when the `name` in
  `wrangler.toml` changed; deploy then targets a different worker. Keep the
  name stable.
