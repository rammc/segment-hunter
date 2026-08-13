# How-To: Wrangler-Setup fuer den Strava-Proxy-Worker

[English](HOWTO-wrangler.md) · **Deutsch**

Diese Anleitung fuehrt durch das Deployment des Cloudflare Workers
(`worker/`, deployed als `strava-kom-proxy`) mit wrangler: vom frischen
Cloudflare-Account bis zum erreichbaren Proxy mit allen Secrets, plus
lokale Entwicklung und CI-Deployment.

## Was ist wrangler?

[Wrangler](https://developers.cloudflare.com/workers/wrangler/) ist das
CLI von Cloudflare fuer Workers. Es bundelt die TypeScript-Quellen, laedt
sie hoch, verwaltet Secrets und startet einen lokalen Dev-Server. Es ist
als Dev-Dependency in `worker/package.json` gepinnt, `npx wrangler` nutzt
also immer die passende Version; keine globale Installation noetig.

## Voraussetzungen

- Node.js 18+ (CI nutzt 22)
- Ein Cloudflare-Account, der Free Tier reicht (100k Requests/Tag)
- Die Strava-Zugangsdaten aus Schritt 1 des [README-Setups](../README.de.md#setup):
  Client ID, Client Secret, Refresh Token

## 1. Einmalig: Login

```bash
cd worker
npm install
npx wrangler login
```

`wrangler login` oeffnet den Browser fuer einen OAuth-Flow und speichert
lokal einen API-Token. Auf einer Headless-Maschine stattdessen
`CLOUDFLARE_API_TOKEN=<token>` als Umgebungsvariable setzen.

## 2. Erstes Deployment

```bash
npx wrangler deploy
```

Wrangler liest [`wrangler.toml`](../worker/wrangler.toml):

```toml
name = "strava-kom-proxy"
main = "src/index.ts"
compatibility_date = "2026-08-01"
```

Wichtig: der `name` ist die Identitaet des Workers. Er bleibt
`strava-kom-proxy`, damit jedes Deployment den bestehenden Worker in place
aktualisiert und Secrets sowie URL erhalten bleiben. Ein Umbenennen wuerde
einen zweiten, leeren Worker ohne Secrets anlegen.

Die Ausgabe zeigt die oeffentliche URL:

```
https://strava-kom-proxy.<account>.workers.dev
```

## 3. Secrets setzen

Secrets leben in Cloudflare, nie im Repo. Jedes `secret put` fragt den
Wert auf stdin ab:

```bash
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put STRAVA_REFRESH_TOKEN
npx wrangler secret put PROXY_KEY          # optional, empfohlen
npx wrangler secret put ANTHROPIC_API_KEY  # optional, nur fuer /coach + /trainingplan
```

| Secret | Zweck | Pflicht |
| --- | --- | --- |
| `STRAVA_CLIENT_ID` | ID der Strava-API-App | ja |
| `STRAVA_CLIENT_SECRET` | Secret der Strava-API-App | ja |
| `STRAVA_REFRESH_TOKEN` | Token, mit dem der Worker Access Tokens holt | ja |
| `PROXY_KEY` | Shared Secret; Requests muessen es als `x-proxy-key`-Header senden | nein, aber empfohlen (sonst ist der Proxy fuer jeden offen, der die URL kennt) |
| `ANTHROPIC_API_KEY` | Aktiviert `POST /coach` und `POST /trainingplan` | nein |

`wrangler secret list` zeigt, welche Secrets gesetzt sind (nur Namen, nie
Werte). Ein gesetztes Secret wirkt sofort, kein Redeploy noetig.

## 4. Verifizieren

```bash
curl -H "x-proxy-key: <KEY>" https://strava-kom-proxy.<account>.workers.dev/health
# -> {"ok":true,"coach":false}
```

`coach` springt auf `true`, sobald `ANTHROPIC_API_KEY` gesetzt ist. Ein
`401` bedeutet: der `x-proxy-key`-Header passt nicht zum `PROXY_KEY`.
Danach eine echte Strava-Route pruefen:

```bash
curl -H "x-proxy-key: <KEY>" "https://strava-kom-proxy.<account>.workers.dev/athlete"
```

Kommt hier das eigene Profil zurueck, funktioniert der Token-Refresh und
das Setup ist komplett. Worker-URL (und Proxy-Key) im Setup-Screen der App
eintragen.

## 5. Lokale Entwicklung

`wrangler dev` startet den Worker lokal mit derselben Runtime (workerd).
Lokale Secrets kommen aus `worker/.dev.vars` (gitignored):

```
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
STRAVA_REFRESH_TOKEN=...
PROXY_KEY=...
```

```bash
cd worker
npm run dev        # wrangler dev, Standard http://localhost:8787
```

Fuer einen lokalen Full-Stack-Test die `VITE_PROXY_URL` des Frontends
(oder das Setup-Feld) auf `http://localhost:8787` zeigen lassen.

## 6. CI-Deployment ueber GitHub Actions

[`deploy-worker.yml`](../.github/workflows/deploy-worker.yml) deployed bei
jedem Push auf `main`, der `worker/` beruehrt. Der Workflow laeuft
`npm ci`, `npm run typecheck` und dann `cloudflare/wrangler-action@v3` mit
dem Repository-Secret `CLOUDFLARE_API_TOKEN`.

Den Token im Cloudflare-Dashboard anlegen: My Profile -> API Tokens ->
Create Token -> Template "Edit Cloudflare Workers". Im GitHub-Repo unter
Settings -> Secrets and variables -> Actions als `CLOUDFLARE_API_TOKEN`
hinterlegen.

CI deployed nur Code. Die in Schritt 3 gesetzten Worker-Secrets werden von
Deployments nicht angefasst, sie werden also genau einmal konfiguriert.

## Troubleshooting

- **`Authentication error [code: 10000]`**: dem API-Token fehlen Rechte
  oder er ist abgelaufen. Mit dem Template "Edit Cloudflare Workers" neu
  erstellen.
- **`/health` nach Deploy nicht erreichbar**: `wrangler deployments list`
  pruefen; die `workers.dev`-Subdomain muss fuer den Account aktiviert sein
  (Dashboard -> Workers -> Worker -> Settings -> Domains & Routes).
- **`401 unauthorized` auf jeder Route**: `PROXY_KEY` ist gesetzt, aber der
  Request sendet keinen passenden `x-proxy-key`-Header.
- **`429`-Antworten**: Strava-Rate-Limit (100 Requests pro 15 Minuten im
  freien API-Tier). Die App zeigt das mit der naechsten Reset-Zeit an.
- **Secrets nach Deploy weg**: passiert nur, wenn der `name` in
  `wrangler.toml` geaendert wurde; das Deployment zielt dann auf einen
  anderen Worker. Namen stabil halten.
