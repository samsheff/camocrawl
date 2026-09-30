/*
 * CamoCrawl — original rendering-service module.
 * Part of CamoCrawl (Firecrawl + Camoufox backend), licensed under the
 * GNU Affero General Public License v3.0 or later; see root LICENSE.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Do not remove this header or any upstream copyright/license notices.
 */
import { firefox, type Browser } from 'playwright-core';
import { launchOptions } from 'camoufox-js';
import type { CamoufoxConfig, ProxyTarget } from './config.js';
import { proxyAuthUrl } from './config.js';
import type { Logger } from './logger.js';
import { startSsrfGuard, type SsrfGuard } from './ssrf.js';

export type CamoufoxBrowser = {
  browser: Browser;
  /** Local SSRF-guard port this browser must use as its proxy. */
  guardPort: number;
  /** Short description of the fingerprint, for logs only. */
  fingerprint: string;
  close: () => Promise<void>;
};

/**
 * Reads a short identity for the generated fingerprint back out of Camoufox's
 * config so operators can confirm fingerprints are actually rotating. The config
 * is handed to the browser through chunked `CAMOU_CONFIG_*` env vars rather than
 * returned as an object, so it has to be reassembled here.
 */
const fingerprintSummary = (launchOpts: {
  env?: Record<string, string>;
}): string => {
  const env = launchOpts.env ?? {};
  const chunks = Object.entries(env)
    .filter(([key]) => /^CAMOU_CONFIG_\d+$/.test(key))
    .sort(([a], [b]) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
    .map(([, value]) => value);

  if (chunks.length === 0) return 'unknown';

  try {
    const config = JSON.parse(chunks.join('')) as Record<string, unknown>;
    const parts: string[] = [];

    // e.g. "Mozilla/5.0 (Windows NT 10.0; Win64; x64; ...) Gecko/20100101 Firefox/135.0"
    const ua = config['navigator.userAgent'];
    if (typeof ua === 'string') {
      const platform = config['navigator.platform'];
      const version = /Firefox\/([\d.]+)/.exec(ua)?.[1];
      parts.push(
        [platform, version ? `firefox/${version}` : null]
          .filter(Boolean)
          .join(' ') || 'unknown-os',
      );
    }

    const locale = config['locale:language'];
    const region = config['locale:region'];
    if (locale || region) parts.push([locale, region].filter(Boolean).join('-'));
    if (config.timezone) parts.push(String(config.timezone));

    return parts.join(' | ') || 'unknown';
  } catch {
    return 'unknown';
  }
};

const buildLaunchOptions = async (options: {
  camoufox: CamoufoxConfig;
  proxy: ProxyTarget | null;
  geoip: boolean;
}): Promise<Record<string, unknown>> => {
  const { camoufox, proxy, geoip } = options;

  return (await launchOptions({
    headless: camoufox.headless,
    os: camoufox.os as never,
    locale: camoufox.locale as never,
    geoip,
    humanize: camoufox.humanize,
    block_images: camoufox.blockImages,
    block_webrtc: camoufox.blockWebrtc,
    window: camoufox.window,
    enable_cache: camoufox.enableCache,
    executable_path: camoufox.executablePath,
    firefox_user_prefs: camoufox.firefoxUserPrefs,
    // Camoufox needs the real upstream proxy here: it uses it both to learn
    // the exit IP for GeoIP alignment and, at launch, to build the Juggler
    // proxy settings. The returned launch options are rewritten to point at
    // our local SSRF guard below, so the browser still cannot bypass the
    // address check.
    proxy: proxy ? proxyAuthUrl(proxy) : undefined,
    // We handle our own SIGINT/SIGTERM and know exactly which browsers are
    // ours, so Playwright must not install its own process-wide handlers.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    i_know_what_im_doing: true,
    debug: camoufox.debug,
  })) as unknown as Record<string, unknown>;
};

/**
 * Launches one Camoufox instance with a freshly generated fingerprint.
 *
 * Every call generates a new fingerprint, which is what makes fingerprint
 * rotation a matter of simply relaunching the browser.
 */
export const launchCamoufox = async (options: {
  camoufox: CamoufoxConfig;
  proxy: ProxyTarget | null;
  allowLocalWebhooks: boolean;
  launchTimeoutMs: number;
  log: Logger;
}): Promise<CamoufoxBrowser> => {
  const { camoufox, proxy, allowLocalWebhooks, launchTimeoutMs, log } = options;
  const geoip = camoufox.geoip && proxy !== null;

  if (proxy && !geoip) {
    log.warn(
      'proxy configured but GeoIP alignment is disabled; the fingerprint timezone/locale will not match the proxy exit IP',
      { proxy: proxy.server },
    );
  }

  const guard: SsrfGuard = await startSsrfGuard({
    allowLocalWebhooks,
    upstreamProxyUrl: proxy ? proxyAuthUrl(proxy) : undefined,
    log: log.child('ssrf'),
  });

  try {
    const launchOpts = await buildLaunchOptions({ camoufox, proxy, geoip });

    // Route all browser traffic through the SSRF guard. Overwriting rather
    // than merging: a context-level proxy would be ignored for some request
    // types, and a browser-level one cannot be bypassed by page scripts.
    (launchOpts as { proxy?: unknown }).proxy = {
      server: `http://127.0.0.1:${guard.port}`,
    };

    const browser = await Promise.race([
      firefox.launch(launchOpts as Parameters<typeof firefox.launch>[0]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Camoufox launch timed out after ${launchTimeoutMs}ms`,
              ),
            ),
          launchTimeoutMs,
        ).unref?.(),
      ),
    ]);

    const fingerprint = fingerprintSummary(
      launchOpts as { env?: Record<string, string> },
    );
    log.debug('camoufox launched', {
      fingerprint,
      geoip,
      guardPort: guard.port,
    });

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await browser.close();
      } catch (error) {
        log.warn('error while closing browser', { error });
      }
      try {
        await guard.close();
      } catch (error) {
        log.warn('error while closing ssrf guard', { error });
      }
    };

    return { browser, guardPort: guard.port, fingerprint, close };
  } catch (error) {
    await guard.close().catch(() => undefined);
    throw error;
  }
};