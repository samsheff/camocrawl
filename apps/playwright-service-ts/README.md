# Camoufox rendering service (Firecrawl)

Browser rendering backend for Firecrawl, backed by a pool of
[Camoufox](https://camoufox.com/) instances. It speaks the same HTTP contract the
previous Chromium/Playwright service did, so `PLAYWRIGHT_MICROSERVICE_URL` keeps
working unchanged:

```bash
POST /scrape
{
  "url": "https://example.com",
  "wait_after_load": 1000,
  "timeout": 15000,
  "headers": { "Cookie": "session=..." },
  "check_selector": "#content",
  "skip_tls_verification": false
}
->
{
  "content": "<!DOCTYPE html>...",
  "pageStatusCode": 200,
  "contentType": "text/html",
  "pageError": "Not Found"        // only when pageStatusCode !== 200
}
```

`GET /health` additionally reports pool state (`engine: "camoufox"`, per-slot
fingerprint, page counts, recycle counters) alongside the existing
`maxConcurrentPages` / `activePages` fields.

## Why Camoufox

Camoufox is a patched Firefox that spoofs a coherent fingerprint (user agent,
platform, screen geometry, WebGL vendor/renderer, fonts, canvas/audio noise,
hardware concurrency) instead of a bag of independently randomised values. A
Chromium instance with a mismatched user agent is comparatively easy to detect;
a mismatched Firefox fingerprint is what Camoufox exists to prevent.

## Architecture

```
POST /scrape
  -> SSRF + request validation
  -> CamoufoxPool.acquire()          leases a browser + fresh context/page
     -> slot N is pinned to proxy N, so a fingerprint always matches its exit IP
  -> per-context routing: SSRF guard, ad blocking, optional media blocking
  -> page.goto / waitForTimeout / waitForSelector / page.content()
  -> lease.release()                 charges the page, recycles if due
```

- `camoufox.ts` — launches one instance with a freshly generated fingerprint
  and a local SSRF guard that forwards to that instance's upstream proxy.
- `pool.ts` — fixed-size pool, concurrency limits, cooperative recycling, crash
  recovery.
- `scrape.ts` — per-request context setup, routing, and extraction.
- `ssrf.ts` — address allowlist checks shared by the HTTP layer and the proxy.
- `config.ts` — all environment parsing and defaults.
- `api.ts` — the HTTP surface.

### Fingerprint rotation

Every launch generates a new fingerprint, so rotation is just "relaunch".
Instances are recycled after `CAMOUFOX_RECYCLE_PAGES` pages or
`CAMOUFOX_MAX_LIFETIME_MS`, whichever comes first. Recycling waits for in-flight
pages to drain, so it never truncates a running scrape.

### Crash handling

A browser that dies is detected via Playwright's `disconnected` event (and by
matching browser-level error text), and is replaced by a background supervisor
with exponential backoff rather than by the request that noticed it. A scrape
that dies this way gets a 502 so Firecrawl's engine waterfall can fall through;
ordinary scrape failures (missing selector, navigation timeout) leave the
browser alone.

## Configuration

### Concurrency

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_CONCURRENT_PAGES` | `10` | Total in-flight pages across the pool |
| `CAMOUFOX_POOL_SIZE` | `2` | Number of Camoufox instances kept warm |
| `CAMOUFOX_PAGES_PER_BROWSER` | `ceil(MAX_CONCURRENT_PAGES / POOL_SIZE)` | Pages per instance |
| `CAMOUFOX_ACQUIRE_TIMEOUT_MS` | `30000` | How long a request waits for a free browser |

Pool capacity is `POOL_SIZE x PAGES_PER_BROWSER`. Raise `CAMOUFOX_POOL_SIZE` for
more fingerprint diversity (each instance needs roughly 300–500 MB), or
`CAMOUFOX_PAGES_PER_BROWSER` to reuse instances more heavily.

### Recycling

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAMOUFOX_RECYCLE_PAGES` | `100` | Pages served before a fingerprint rotates |
| `CAMOUFOX_MAX_LIFETIME_MS` | `1800000` | Maximum instance age (30 min) |

### Proxies

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROXY_SERVER` | – | Single upstream proxy, e.g. `host:port` |
| `PROXY_USERNAME` / `PROXY_PASSWORD` | – | Credentials for `PROXY_SERVER` |
| `PROXY_SERVERS` | – | `server\|username\|password` entries separated by `;` |
| `CAMOUFOX_GEOIP` | `auto` | Align fingerprint geo/timezone with the proxy exit IP |

`PROXY_SERVERS` takes precedence when set. Browser N is pinned to entry N, so a
fingerprint stays consistent with its exit IP across recycles — important when
target sites correlate the two. The `|` separator keeps generated passwords
(which often contain commas and colons) parseable.

With `CAMOUFOX_GEOIP=auto` (the default), GeoIP alignment turns on whenever a
proxy is configured. It resolves the exit IP through that proxy and aligns
timezone, locale, geolocation and WebRTC. Without a proxy it stays off, since it
would only ever resolve the container's own address.

### Fingerprint

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAMOUFOX_HEADLESS` | `true` | Headless mode |
| `CAMOUFOX_OS` | random | `linux`, `macos`, `windows`, or a comma-separated list |
| `CAMOUFOX_LOCALE` | random | e.g. `en-US,en` |
| `CAMOUFOX_WINDOW` | – | Pin the spoofed window, e.g. `1280x800` |
| `CAMOUFOX_VIEWPORT` | – | Pin the Playwright viewport, e.g. `1280x800` |
| `CAMOUFOX_HUMANIZE` | `false` | Humanised cursor movement (seconds) |
| `CAMOUFOX_BLOCK_WEBRTC` | `true` (compose) | Disable WebRTC entirely |
| `CAMOUFOX_BLOCK_IMAGES` | `false` | Block images at the browser level |
| `CAMOUFOX_BLOCK_SERVICE_WORKERS` | `true` | Keep route interception authoritative |
| `CAMOUFOX_ENABLE_CACHE` | `false` | Let the browser cache pages |
| `CAMOUFOX_FIREFOX_PREFS` | – | JSON object merged into Firefox prefs |
| `CAMOUFOX_DEBUG` | `false` | Print the generated fingerprint config |

Leave `CAMOUFOX_WINDOW` and `CAMOUFOX_VIEWPORT` unset unless you have a reason
to pin them: Camoufox's spoofed screen geometry is self-consistent, and
overriding the viewport on top of it can desync `screen.*` from the real window.
`CAMOUFOX_BLOCK_SERVICE_WORKERS` defaults to on because Firefox has no
per-context equivalent of Playwright's `serviceWorkers: "block"`; leaving
service workers on lets them bypass the SSRF-checked request interceptor.

### General

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `ALLOW_LOCAL_WEBHOOKS` | `false` | Permit scraping private/internal addresses |
| `BLOCK_MEDIA` | `false` | Abort image/audio/video requests |
| `CAMOUFOX_LAUNCH_TIMEOUT_MS` | `90000` | Cap on a single launch |
| `CAMOUFOX_RELAUNCH_BACKOFF_MS` | `1000` | Initial relaunch backoff |
| `CAMOUFOX_RELAUNCH_BACKOFF_MAX_MS` | `30000` | Backoff ceiling |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | Grace period on SIGTERM/SIGINT |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

Malformed values fail fast with a `ConfigError` rather than silently falling back
to a default.

## Development

```bash
pnpm install
pnpm run camoufox:fetch   # downloads the browser + GeoLite2 database
pnpm run dev              # tsx, hot entry point
pnpm test                 # vitest unit/integration suite (no browser needed)
pnpm run build && pnpm start
```

The test suite mocks the browser, so it runs fast and without downloading
Camoufox.

## Notes for operators

- **`shm_size`**: Firefox needs more shared memory than Chromium. The compose
  file sets `shm_size: 1gb`.
- **Orphaned processes**: the container runs under `dumb-init` so Firefox child
  processes left behind by a crash get reaped.
- **Signals**: Playwright's own signal handling is disabled so the service owns
  teardown and closes every browser deterministically; in-flight scrapes finish
  before the browsers go away.
- **Resource limits**: `CAMOUFOX_POOL_SIZE` and the container's CPU/memory limits
  should be raised together.