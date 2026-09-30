<p align="center">
  <img src="./logo.png" height="200" alt="CamoCrawl logo — a camouflaged fox curled around a network globe">
</p>

<h1 align="center">CamoCrawl</h1>

<p align="center">
  <strong>Firecrawl with a Camoufox browser backend.</strong><br>
  Self-hostable web scraping and crawling — Firecrawl's API and extraction
  pipeline rendering through a pool of anti-detect Camoufox (Firefox) instances.
</p>

<p align="center">
  <a href="./LICENSE">AGPL-3.0</a> ·
  <a href="./NOTICE">Notices</a> ·
  <a href="./THIRD_PARTY_LICENSES/">Third-party licenses</a> ·
  <a href="./SELF_HOST.md">Self-hosting</a> ·
  <a href="./apps/playwright-service-ts/README.md">Rendering-service docs</a>
</p>

> **Fork notice.** CamoCrawl is an independent, non-commercial community fork
> of [Firecrawl](https://github.com/firecrawl/firecrawl). It is not affiliated
> with, endorsed, or supported by Firecrawl (Sideguide Technologies Inc.) or
> by the Camoufox project. Upstream copyright notices and license texts are
> preserved — see [Licensing](#licensing) and [`NOTICE`](./NOTICE).

---

## Table of contents

- [What problem it solves](#what-problem-it-solves)
- [Firecrawl × Camoufox relationship](#firecrawl--camoufox-relationship)
- [Architecture overview](#architecture-overview)
- [Key features](#key-features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Docker / Docker Compose](#docker--docker-compose)
- [Configuration and environment variables](#configuration-and-environment-variables)
- [Example crawl / API usage](#example-crawl--api-usage)
- [Development](#development)
- [Testing](#testing)
- [Repository structure](#repository-structure)
- [Troubleshooting](#troubleshooting)
- [Upstream projects and acknowledgements](#upstream-projects-and-acknowledgements)
- [Licensing](#licensing)
- [Contributing](#contributing)

---

## What problem it solves

Firecrawl's self-hosted stack renders JavaScript-heavy pages with a
Chromium-based Playwright service. Chromium with a patched user agent is
comparatively easy for bot-mitigation systems to fingerprint, which means
more blocks, captchas, and empty renders on protected targets.

CamoCrawl keeps Firecrawl's API, crawling engine, queueing, and extraction
pipeline intact and swaps the rendering backend for
[Camoufox](https://camoufox.com/) — a patched Firefox that spoofs a coherent,
self-consistent device fingerprint (user agent, platform, screen geometry,
WebGL, fonts, canvas/audio noise, locale/timezone) instead of a bag of
independently randomised values. Each browser instance in the pool gets a
freshly generated fingerprint, and instances are recycled on a page-count or
age budget so fingerprints rotate automatically.

In short: **the Firecrawl API you already know, with pages rendered by a
browser built to blend into real traffic.**

---

## Firecrawl × Camoufox relationship

| Project | Role in CamoCrawl | Upstream |
|---------|-------------------|----------|
| **Firecrawl** | The whole platform: REST API (`/scrape`, `/crawl`, `/map`, `/search`, `/batch`, agent/extract), workers, queues, extraction to Markdown/JSON, SDKs. CamoCrawl is a fork of this codebase. | https://github.com/firecrawl/firecrawl |
| **Camoufox** | The browser that actually loads pages: a stealth Firefox fork plus the `camoufox-js` client used to launch it with generated fingerprints. | https://github.com/daijro/camoufox · https://github.com/apify/camoufox-js |
| **CamoCrawl** (this repo) | The glue: a rewritten rendering microservice (`apps/playwright-service-ts`) that speaks Firecrawl's existing `POST /scrape` contract but serves it from a pooled set of Camoufox instances, plus the Docker/Compose/Helm/CI wiring to run it. | — |

The integration point is deliberately narrow: Firecrawl already delegates
rendering to a microservice via `PLAYWRIGHT_MICROSERVICE_URL`. CamoCrawl
replaces that service's internals (Chromium → Camoufox pool) while keeping
the HTTP contract, so the rest of the Firecrawl engine calls it unchanged.

No Camoufox source code is vendored in this repository. Camoufox arrives as
an npm dependency (`camoufox-js`) and as a browser binary downloaded at
Docker build time. See [Licensing](#licensing).

---

## Architecture overview

```
                        ┌─────────────────────────────┐
POST /v1/scrape         │      Firecrawl API (apps/api)│
POST /v1/crawl  ──────► │  queue (Redis/RabbitMQ/nuq)  │──► workers ──► Markdown/JSON
POST /v1/map            │  extraction, search, agent   │
                        └──────────────┬──────────────┘
                                       │ PLAYWRIGHT_MICROSERVICE_URL
                                       ▼  POST /scrape
                        ┌──────────────────────────────┐
                        │ Camoufox rendering service   │
                        │ (apps/playwright-service-ts) │
                        │                              │
                        │  CamoufoxPool (pool.ts)      │
                        │   slot 0 ─► Camoufox #0 ─┐   │
                        │   slot 1 ─► Camoufox #1 ─┼─► │ web
                        │   slot N ─► Camoufox #N ─┘   │
                        │                              │
                        │  per-request: SSRF guard,    │
                        │  ad/media blocking, cookies, │
                        │  goto → wait → content()     │
                        └──────────────────────────────┘
```

Request flow inside the rendering service
(`apps/playwright-service-ts/README.md` has the full version):

1. `POST /scrape` validates the URL and runs the SSRF allowlist check.
2. `CamoufoxPool.acquire()` leases a browser slot plus a fresh
   browser context and page. Slot *N* is pinned to proxy *N* so a
   fingerprint always matches its exit IP.
3. Per-context routing enforces the SSRF policy again at request level,
   drops ad-serving domains, and optionally blocks media.
4. `page.goto()` → optional `wait_after_load` / `check_selector` →
   `page.content()` (or raw body for JSON/plain-text responses).
5. The lease is released; the page counts against the instance's recycle
   budget (`CAMOUFOX_RECYCLE_PAGES` / `CAMOUFOX_MAX_LIFETIME_MS`). Recycling
   waits for in-flight pages to drain, so running scrapes are never cut off.
6. A crashed browser is detected via Playwright's `disconnected` event and
   replaced by a background supervisor with exponential backoff; that scrape
   gets a `502` so Firecrawl's engine waterfall can fall through to the next
   engine.

---

## Key features

- **Drop-in rendering backend** — same `POST /scrape` contract as Firecrawl's
  previous Chromium service; `PLAYWRIGHT_MICROSERVICE_URL` keeps working.
- **Pooled Camoufox instances** — configurable pool size and pages-per-browser
  (`CAMOUFOX_POOL_SIZE`, `CAMOUFOX_PAGES_PER_BROWSER`); capacity is
  `pool size × pages per browser`.
- **Automatic fingerprint rotation** — every launch generates a fresh
  fingerprint; instances recycle after N pages or a max lifetime.
- **Proxy-pinned slots** — single `PROXY_SERVER` or a `PROXY_SERVERS` pool
  (`server|username|password` entries); slot *N* always uses entry *N*.
- **GeoIP fingerprint alignment** — timezone/locale/geolocation/WebRTC follow
  the proxy exit IP (`CAMOUFOX_GEOIP=auto` by default when a proxy is set).
- **SSRF protection in depth** — target validation at the HTTP layer, a
  per-browser local guard proxy, and request interception in every context;
  service workers are blocked by default so traffic can't bypass interception.
- **Fail-fast under load** — bounded acquire timeouts and cooperative
  recycling, so the HTTP layer returns real statuses instead of hanging past
  Firecrawl's scrape timeout.
- **Observability** — `GET /health` reports `engine: "camoufox"` plus per-slot
  fingerprints, page counts, and recycle counters; structured JSON logs.
- **Hardened container** — runs as non-root, `dumb-init` reaps orphaned
  Firefox children, Firefox-sized `shm_size` and memory limits in Compose.
- **Full Firecrawl surface on top** — scrape, crawl, map, batch scrape,
  search, and the Firecrawl SDKs all work against the self-hosted API.

---

## Prerequisites

- **Docker** with the Compose v2 plugin (`docker compose`, not the legacy
  `docker-compose`). [Install Docker](https://docs.docker.com/get-docker/).
- For running the rendering service outside Docker: **Node.js ≥ 22.13** and
  **pnpm 11** (`corepack enable`), plus the system libraries for Firefox
  (`pnpm exec playwright-core install-deps firefox` on Debian/Ubuntu).
- For the full API stack from source: Redis, PostgreSQL, and the Go toolchain
  for the `go-html-to-md` shared library — or just use Compose, which wires
  all of this for you.
- Optional: an OpenAI-compatible API key for AI extraction features; a proxy
  (or pool of proxies) for production crawling; a SearXNG endpoint for the
  `/search` API.

---

## Installation

```bash
git clone <your-camocrawl-repo-url> camocrawl
cd camocrawl

# 1. Create your environment file from the documented template
#    (see SELF_HOST.md — the block below is the minimal starting point)
cat > .env <<'EOF'
PORT=3002
HOST=0.0.0.0
USE_DB_AUTHENTICATION=false
BULL_AUTH_KEY=CHANGEME
EOF

# 2. Build and start everything (API, Camoufox rendering service,
#    Redis, RabbitMQ, Postgres)
docker compose build
docker compose up
```

The API listens on `http://localhost:3002` and the Bull queue dashboard on
`http://localhost:3002/admin/CHANGEME/queues`.

> The first build downloads the Camoufox browser, the GeoLite2 city database,
> and bundled addons into the rendering-service image, so it takes longer
> than a plain rebuild. This is expected.

---

## Quick start

**1. Scrape a page** (single URL → Markdown/HTML via the API):

```bash
curl -X POST http://localhost:3002/v1/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "formats": ["markdown"]}'
```

**2. Talk to the rendering service directly** (what the API calls internally):

```bash
curl -X POST http://localhost:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "wait_after_load": 1000, "timeout": 15000}'
# -> {"content": "<!DOCTYPE html>...", "pageStatusCode": 200, "contentType": "text/html"}
```

**3. Check pool health** (per-slot fingerprints, capacity, recycle counters):

```bash
curl http://localhost:3000/health
```

**4. Crawl a site** (async job, then poll):

```bash
JOB=$(curl -s -X POST http://localhost:3002/v1/crawl \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "limit": 10}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
curl http://localhost:3002/v1/crawl/$JOB
```

With a Firecrawl SDK, point it at your instance instead of the cloud
(no API key needed for self-hosted):

```python
from firecrawl import Firecrawl

app = Firecrawl(api_key="no-key-needed", api_url="http://localhost:3002")
doc = app.scrape("https://example.com", formats=["markdown"])
print(doc.markdown)
```

---

## Docker / Docker Compose

Services in [`docker-compose.yaml`](./docker-compose.yaml):

| Service | Image / build | Purpose |
|---------|---------------|---------|
| `api` | builds `apps/api` | Firecrawl API + workers; serves `:3002` |
| `playwright-service` | builds `apps/playwright-service-ts` | **CamoCrawl's Camoufox pool**; serves `:3000`, health-gated before the API starts |
| `redis` | `redis:alpine` | rate limits, caching |
| `rabbitmq` | `rabbitmq:3-management` | job transport |
| `nuq-postgres` | builds `apps/nuq-postgres` | queue persistence |
| `foundationdb` / `foundationdb-init` | `foundationdb/foundationdb:7.3.63` | experimental queue backend (enable with `NUQ_BACKEND=fdb`) |

Useful commands:

```bash
docker compose up --build playwright-service   # rebuild just the browser service
docker compose logs -f playwright-service      # watch pool launches / recycles
docker compose exec nuq-postgres psql          # DB maintenance (no DB port is exposed)
docker compose down
```

Kubernetes users: Helm values and manifests under
`examples/kubernetes/` include the Camoufox settings
(`CAMOUFOX_POOL_SIZE`, `CAMOUFOX_RECYCLE_PAGES`,
`CAMOUFOX_MAX_LIFETIME_MS`, `CAMOUFOX_GEOIP`, resource requests/limits sized
for Firefox process trees). See the chart README for install steps.

---

## Configuration and environment variables

All rendering-service settings are parsed in
`apps/playwright-service-ts/config.ts` and **fail fast with a `ConfigError`**
on malformed values rather than silently falling back.

### Concurrency

| Variable | Default | Meaning |
|----------|---------|---------|
| `MAX_CONCURRENT_PAGES` | `10` | Total in-flight pages across the whole pool |
| `CAMOUFOX_POOL_SIZE` | `2` | Camoufox instances kept warm (~300–500 MB each — raise container memory together) |
| `CAMOUFOX_PAGES_PER_BROWSER` | `ceil(MAX / POOL)` | Concurrent pages per instance |
| `CAMOUFOX_ACQUIRE_TIMEOUT_MS` | `30000` | How long a request waits for a free browser before failing |

### Recycling (fingerprint rotation)

| Variable | Default | Meaning |
|----------|---------|---------|
| `CAMOUFOX_RECYCLE_PAGES` | `100` | Pages served before an instance is replaced |
| `CAMOUFOX_MAX_LIFETIME_MS` | `1800000` (30 min) | Max instance age before replacement |
| `CAMOUFOX_RELAUNCH_BACKOFF_MS` / `CAMOUFOX_RELAUNCH_BACKOFF_MAX_MS` | `1000` / `30000` | Crash-relaunch backoff range |

### Proxies and GeoIP

| Variable | Default | Meaning |
|----------|---------|---------|
| `PROXY_SERVER` (+ `PROXY_USERNAME` / `PROXY_PASSWORD`) | — | Single upstream proxy for all browsers |
| `PROXY_SERVERS` | — | `server\|username\|password` entries separated by `;`; slot *N* pinned to entry *N*; takes precedence over `PROXY_SERVER` |
| `CAMOUFOX_GEOIP` | `auto` | `auto` = align fingerprint geo/timezone/locale with the proxy exit IP whenever a proxy is configured; `true`/`false` force it |

### Fingerprint tuning

| Variable | Default | Meaning |
|----------|---------|---------|
| `CAMOUFOX_HEADLESS` | `true` | Headless mode |
| `CAMOUFOX_OS` | random | `linux`, `macos`, `windows` (or comma-separated list to sample from) |
| `CAMOUFOX_LOCALE` | random | e.g. `en-US,en` |
| `CAMOUFOX_WINDOW` | — | Pin spoofed window size, e.g. `1280x800` (leave unset to keep Camoufox self-consistent) |
| `CAMOUFOX_VIEWPORT` | — | Pin Playwright viewport, e.g. `1280x800` |
| `CAMOUFOX_HUMANIZE` | `false` | Human-like cursor movement (`true` or seconds) |
| `CAMOUFOX_BLOCK_WEBRTC` | `true` (in Compose) | Disable WebRTC |
| `CAMOUFOX_BLOCK_IMAGES` | `false` | Block images at browser level |
| `CAMOUFOX_BLOCK_SERVICE_WORKERS` | `true` | Keep request interception authoritative (Firefox has no per-context service-worker block) |
| `CAMOUFOX_ENABLE_CACHE` | `false` | Let the browser cache pages |
| `CAMOUFOX_FIREFOX_PREFS` | — | JSON object merged into Firefox launch prefs |
| `CAMOUFOX_DEBUG` | `false` | Log the generated fingerprint config |
| `CAMOUFOX_EXECUTABLE_PATH` | — | Custom browser binary path |
| `CAMOUFOX_LAUNCH_TIMEOUT_MS` | `90000` | Cap on a single browser launch |

### General / API stack

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` (service) / `3002` (API) | Listen ports |
| `PLAYWRIGHT_MICROSERVICE_URL` | `http://playwright-service:3000/scrape` (Compose) | Where the API sends render requests |
| `ALLOW_LOCAL_WEBHOOKS` | `false` | Permit scraping private/internal addresses (dev only) |
| `BLOCK_MEDIA` | `false` | Abort image/audio/video requests |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | Grace period on SIGTERM/SIGINT |
| `BULL_AUTH_KEY` | `CHANGEME` | Queue-admin UI secret — **change this on any reachable deployment** |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OLLAMA_BASE_URL` | — | AI extraction features |
| `SEARXNG_ENDPOINT` | — | Self-hosted search backend |

The full self-host template with security notes lives in
[`SELF_HOST.md`](./SELF_HOST.md).

---

## Example crawl / API usage

Render path (Camoufox service contract — also what `PLAYWRIGHT_MICROSERVICE_URL` points at):

```bash
# JavaScript-rendered page, wait 2 s for client hydration, require a selector
curl -X POST http://localhost:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com/app",
    "wait_after_load": 2000,
    "timeout": 30000,
    "headers": {"Cookie": "session=abc"},
    "check_selector": "#content"
  }'
```

Firecrawl API path (crawl + poll; SDKs handle polling for you):

```bash
curl -X POST http://localhost:3002/v1/crawl \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://docs.example.com",
    "limit": 50,
    "scrapeOptions": {"formats": ["markdown"]}
  }'
# {"success": true, "id": "123-456-789", "url": "http://localhost:3002/v1/crawl/123-456-789"}

curl http://localhost:3002/v1/crawl/123-456-789
```

```javascript
// Node.js SDK against a self-hosted CamoCrawl instance
import { Firecrawl } from 'firecrawl';

const app = new Firecrawl({ apiKey: 'no-key-needed', apiUrl: 'http://localhost:3002' });
const doc = await app.scrape('https://example.com', { formats: ['markdown'] });
console.log(doc.markdown);
```

Response shapes, SDKs for Python/Go/Java/Rust/Ruby/.NET/PHP/Elixir, and the
search/agent/extract endpoints follow upstream Firecrawl — see the
[Firecrawl documentation](https://docs.firecrawl.dev) and
[`SELF_HOST.md`](./SELF_HOST.md).

---

## Development

Prerequisites: Node.js ≥ 22.13, pnpm 11, Docker (for Redis/Postgres or the
full stack).

```bash
# Rendering service only (fast loop, mocked-browser tests need no browser)
cd apps/playwright-service-ts
pnpm install
pnpm run camoufox:fetch   # downloads the Camoufox browser + GeoLite2 data
pnpm run dev              # hot entry point (tsx api.ts), default PORT 3000
pnpm test                 # vitest suite
pnpm run build && pnpm start

# Full stack
docker compose build
docker compose up
```

Per [AGENTS.md](./AGENTS.md), API changes should add end-to-end `snips`
tests (`apps/api/src/__tests__/snips/`) covering a happy path and at least
one failure path, gated on `TEST_SUITE_SELF_HOSTED`/AI availability, and run
them via `pnpm harness jest …` rather than hand-rolled servers.

---

## Testing

| Scope | Command | Notes |
|-------|---------|-------|
| Rendering service unit/integration | `cd apps/playwright-service-ts && pnpm test` | 57 tests across `config`, `scrape`, `pool`, `api` specs; browser is mocked, no Camoufox download needed |
| Rendering service build | `cd apps/playwright-service-ts && pnpm run build` | `tsc` (ESM/`nodenext`); must pass clean |
| Compose validity | `docker compose config` | Validates service wiring without starting containers |
| API end-to-end (incl. `camoufox-rendering.test.ts`) | `cd apps/api && pnpm harness jest …` | Needs the full harness (API + workers + rendering service); Camoufox assertions only run where `PLAYWRIGHT_MICROSERVICE_URL` is configured on a self-hosted instance |
| CI | `.github/workflows/test-server.yml` | Restores/caches the Camoufox browser, starts the rendering service, waits on `/health`, runs the matrix |

`apps/api/src/__tests__/snips/v2/camoufox-rendering.test.ts` covers the
Camoufox-specific win conditions: client-side JS execution, non-empty
rendered markup over concurrent load, and stable results across fingerprint
recycles.

---

## Repository structure

```
.
├── LICENSE                      # AGPL-3.0 (+ Firecrawl copyright notice)
├── NOTICE                         # fork/attribution map: Firecrawl, Camoufox, CamoCrawl
├── THIRD_PARTY_LICENSES/          # MPL-2.0 text for camoufox-js + dependency index
├── README.md                      # this file
├── SELF_HOST.md                   # self-host env template + ops guide
├── docker-compose.yaml            # api + playwright-service (Camoufox) + redis/rabbit/pg
├── logo.png                       # CamoCrawl brand logo
├── apps/
│   ├── api/                       # Firecrawl API, workers, extraction (AGPL-3.0)
│   │   └── src/__tests__/snips/v2/camoufox-rendering.test.ts  # CamoCrawl e2e
│   ├── playwright-service-ts/     # ★ CamoCrawl's Camoufox rendering service
│   │   ├── api.ts                 # HTTP surface (rewritten from Firecrawl's Chromium service)
│   │   ├── camoufox.ts            # one-instance launch w/ fresh fingerprint + SSRF guard
│   │   ├── pool.ts                # fixed-size pool, pinning, recycling, crash recovery
│   │   ├── scrape.ts              # per-request context/routing/extraction
│   │   ├── ssrf.ts                # allowlist checks shared by HTTP layer + proxy
│   │   ├── config.ts              # env parsing, proxy/fingerprint options
│   │   ├── logger.ts              # minimal structured logger
│   │   ├── *.spec.ts              # mocked-browser test suite (no browser needed)
│   │   ├── Dockerfile             # fetches Camoufox browser at build time, runs as non-root
│   │   └── README.md              # service-level deep dive
│   ├── js-sdk/ python-sdk/ go-sdk/ …  # Firecrawl SDKs (MIT, per-directory LICENSE)
│   ├── nuq-postgres/ redis/ test-site/ test-suite/ ui/ siem/ …
├── examples/kubernetes/           # Helm chart + manifests (Camoufox settings included)
└── .github/workflows/             # CI incl. Camoufox fetch/cache + health-gated startup
```

**Code provenance at a glance:**

| Category | Paths | License basis |
|----------|-------|---------------|
| Firecrawl-derived (unmodified) | `apps/api`, SDKs, `apps/ui`, most of repo | AGPL-3.0 (root `LICENSE`); SDKs/UI per-dir MIT |
| Firecrawl-derived (modified by CamoCrawl) | `apps/playwright-service-ts/api.ts`, `Dockerfile`, `docker-compose.yaml`, Helm values/manifests, `test-server.yml`, `SELF_HOST.md`, service `package.json`/`tsconfig` | AGPL-3.0; modifications marked in file headers |
| CamoCrawl-original | `apps/playwright-service-ts/{camoufox,config,pool,scrape,ssrf,logger}.ts`, `*.spec.ts`, `vitest.config.ts`, `camoufox-rendering.test.ts` | AGPL-3.0; header in each file |
| Camoufox (not vendored) | `camoufox-js` npm dep; browser binary fetched at build | MPL-2.0 (plus LGPLv3 note for upstream `cursory`, GeoLite2 EULA) |
| Third-party deps | `playwright-core`, `express`, `proxy-chain`, `ipaddr.js`, `dotenv`, … | Apache-2.0 / MIT / BSD-2-Clause per package; see `THIRD_PARTY_LICENSES/` |

No reorganisation was needed to make these boundaries clear: Camoufox is a
runtime dependency (never copied into the tree), and all CamoCrawl-original
or rewritten sources live in `apps/playwright-service-ts/` with provenance
headers — so no files were moved.

---

## Troubleshooting

**Rendering service won't start / `/health` returns 503**
`{"status":"unhealthy","error":"No healthy Camoufox browser is available"}` —
every pool slot failed to launch. Check `docker compose logs
playwright-service` for `camoufox launch failed`: common causes are no
network egress to fetch GeoIP data on first launch, too-small `shm_size`, or
an unreachable upstream proxy. CI waits on `/health` (up to 120 s) rather
than the TCP port for exactly this reason.

**Scrapes return 502 `Browser instance failed…`**
A browser died mid-scrape and its slot is being replaced; the request was
already failed over. Occasional 502s under memory pressure mean the pool is
undersized — raise `CAMOUFOX_POOL_SIZE` *and* the container's memory limit
together (~300–500 MB per instance).

**Scrapes time out waiting for a browser**
`Timed out … waiting for a free Camoufox browser` — pool saturated. Raise
`CAMOUFOX_POOL_SIZE` (more fingerprints) or `CAMOUFOX_PAGES_PER_BROWSER`
(more reuse), or lower client concurrency. `GET /health` shows
`activePages` vs `capacity`.

**Empty or selector-missing renders**
If `check_selector` fails with `Required selector not found`, the page likely
needs longer hydration — increase `wait_after_load`. If raw HTML is short or
empty, the target may be blocking the datacenter IP: configure
`PROXY_SERVER`/`PROXY_SERVERS`.

**Service workers / exfiltration concerns**
`CAMOUFOX_BLOCK_SERVICE_WORKERS` defaults to `true` because Firefox lacks a
per-context service-worker block and workers would bypass request
interception. Leave it on unless you have a specific reason.

**Redis / Postgres / queue issues, auth warnings, ports**
Unchanged from upstream — see [`SELF_HOST.md`](./SELF_HOST.md)
troubleshooting (Supabase/auth warnings are benign on self-hosted installs;
keep the DB port internal; set a strong `BULL_AUTH_KEY`).

**It is the sole responsibility of end users to respect websites' policies
when scraping.** Adhere to applicable privacy policies and terms of use;
CamoCrawl respects `robots.txt` by default via the Firecrawl engine.

---

## Upstream projects and acknowledgements

- **[Firecrawl](https://github.com/firecrawl/firecrawl)** by Sideguide
  Technologies Inc. — the platform this fork builds on: API, crawling engine,
  extraction, and SDKs. Thank you for open-sourcing it under AGPL-3.0.
- **[Camoufox](https://github.com/daijro/camoufox)** by Daijro — the
  anti-detect Firefox fork doing the actual rendering, including its
  fingerprint-generation and stealth work.
- **[camoufox-js](https://github.com/apify/camoufox-js)** — the JS client used
  to launch Camoufox (MPL-2.0).
- **[Playwright](https://playwright.dev/)** (Microsoft) — browser automation
  protocol and `playwright-core` client (Apache-2.0).
- **[Fingerprint Generator (`fpgen`)](https://github.com/scrapfly/fingerprint-generator)**
  (Scrapfly), **[Cursory](https://github.com/Vinyzu/cursory)** (Vinyzu),
  LibreWolf/Ghostery/FastFox/PeskyFox patch and config sources — via
  Camoufox's documented lineage.
- **MaxMind GeoLite2** — geolocation data used for fingerprint/proxy
  alignment (separate EULA).

---

## Licensing

**Plain-English summary (not legal advice).** CamoCrawl is a combined work
containing components under different licenses, and each component's terms
keep applying to that component:

- **Firecrawl-derived code and CamoCrawl-original code** (the API, workers,
  the rendering service in `apps/playwright-service-ts`, Compose/Helm/CI
  wiring, docs) are covered by the **GNU Affero General Public License v3.0
  (AGPL-3.0)** in the root [`LICENSE`](./LICENSE). In practice this means you
  can run, study, modify, and share them — but if you run a modified version
  as a network service (which a self-hosted crawl API is), you must offer
  every user of that service the corresponding source code, keep all
  copyright/license notices intact, and license your modifications under the
  same terms.
- **Firecrawl SDKs and some UI components** carry their own **MIT License**
  notices — see the `LICENSE` files in those directories. Those permissive
  terms apply to those directories as marked upstream.
- **Camoufox pieces are *not* relicensed by this repo.** The `camoufox-js`
  client is **MPL-2.0** (copy in
  [`THIRD_PARTY_LICENSES/camoufox-js-MPL-2.0.md`](./THIRD_PARTY_LICENSES/camoufox-js-MPL-2.0.md));
  the Camoufox browser binary you download at build time is likewise
  **MPL-2.0** upstream, with the noted exception that its vendored `cursory`
  cursor library is **LGPLv3-or-later**, and the GeoLite2 data is under
  MaxMind's own EULA. Nothing in this repository changes those terms.
- **Other npm dependencies** (`playwright-core`, `express`, `proxy-chain`,
  `ipaddr.js`, `dotenv`, …) keep their own Apache-2.0/MIT/BSD-2-Clause terms
  — indexed in [`THIRD_PARTY_LICENSES/README.md`](./THIRD_PARTY_LICENSES/README.md).

Because upstream files keep their own requirements, **it would be wrong to
say the whole repository is under a single license** — the table in
[Repository structure](#repository-structure), [`NOTICE`](./NOTICE), and the
per-file headers state which terms apply where.

> **⚠️ Contributors: do not remove or alter existing copyright notices,
> license headers, `LICENSE` files, or attribution notices.** If you add a
> file derived from Firecrawl or from any upstream project, copy its header
> and note the modification. If you add a dependency with attribution or
> copyleft terms, record it in `THIRD_PARTY_LICENSES/` and `NOTICE`. When in
> doubt, keep the notice and ask in your pull request.

---

## Contributing

CamoCrawl welcomes contributions — bug reports, fingerprint/stealth tuning,
docs, and test coverage are especially valuable.

1. Fork the repo and create a focused branch.
2. For API changes, add `snips` end-to-end tests per [AGENTS.md](./AGENTS.md)
   (one happy path + at least one failure path); for rendering-service
   changes, extend the mocked `*.spec.ts` suite (`pnpm test` — no browser
   needed).
3. Run the checks your change touches: `pnpm run build`, `pnpm test`,
   `docker compose config`, and — if you touched the render path — a real
   crawl against the Camoufox service.
4. Preserve every copyright/license header and attribution file, and update
   `NOTICE` / `THIRD_PARTY_LICENSES/` if your change adds upstream code or
   dependencies.
5. Open a pull request describing the behavior change, the tests, and any
   licensing-relevant additions.

By contributing you agree your changes will be distributed under the same
terms as the code you modify (AGPL-3.0 for the service/API tree; see
[Licensing](#licensing)). If you cannot agree to that for a particular
change, say so in the PR rather than stripping notices.

---

*End users are solely responsible for complying with target websites'
policies and applicable law when scraping. CamoCrawl respects robots.txt by
default.*
