# Third-party licenses

This directory records the licenses of upstream components CamoCrawl builds
on or runs with. It supplements — never replaces — the license files kept
alongside the code itself:

- Root [`LICENSE`](../LICENSE) — GNU Affero General Public License v3.0
  (AGPL-3.0), covering Firecrawl-derived code and CamoCrawl-original code
  (see [`NOTICE`](../NOTICE) and the Licensing section of the root README).
- Per-directory `LICENSE` files (e.g. `apps/js-sdk/LICENSE`,
  `apps/python-sdk/LICENSE`) — MIT, for the Firecrawl SDKs and some UI
  components, as marked upstream.
- [`NOTICE`](../NOTICE) — how the Firecrawl, Camoufox, and CamoCrawl parts
  fit together.

## Included license texts

| File | What it covers |
|------|----------------|
| `camoufox-js-MPL-2.0.md` | Verbatim copy of the `LICENSE.md` shipped with
  [`camoufox-js@0.12.0`](https://github.com/apify/camoufox-js) (Mozilla Public
  License 2.0). CamoCrawl depends on this package but does not vendor or
  modify its sources. |

## Runtime dependency licenses (not vendored; notices remain applicable)

These packages are resolved from npm at install time. Their licenses were
read from each package's published `package.json` metadata on 2026-09-30:

| Package | Version used | License | Upstream |
|---------|--------------|---------|----------|
| `camoufox-js` | ^0.12.0 (0.12.0 installed) | MPL-2.0 | https://github.com/apify/camoufox-js |
| `playwright-core` | 1.60.0 (pinned, see `apps/playwright-service-ts/pnpm-workspace.yaml`) | Apache-2.0 | https://github.com/microsoft/playwright |
| `express` | ^5.2.1 | MIT | https://github.com/expressjs/express |
| `proxy-chain` | ^2.7.1 | Apache-2.0 | https://github.com/apify/proxy-chain |
| `ipaddr.js` | ^2.3.0 | MIT | https://github.com/whitequark/ipaddr.js |
| `dotenv` | ^16.4.5 | BSD-2-Clause | https://github.com/motdotla/dotenv |

## Downloaded-at-build-time components (not checked in)

| Component | License | Notes |
|-----------|---------|-------|
| Camoufox browser binary + GeoLite2 data (`pnpm run camoufox:fetch` / `apps/playwright-service-ts/Dockerfile`) | MPL-2.0 (browser, https://github.com/daijro/camoufox) | The browser is fetched from upstream releases at build time. Upstream notes that its vendored `cursory` cursor library (`additions/juggler/input/cursory/`) is LGPLv3-or-later, not MPL-2.0. MaxMind GeoLite2 data carries its own EULA/attribution terms — see https://www.maxmind.com/en/geolite2/eula. |

If you add a dependency with a copyleft or attribution requirement, add its
license text (or a precise pointer) here and mention it in `NOTICE`.
