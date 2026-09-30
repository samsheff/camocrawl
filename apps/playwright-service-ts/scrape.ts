/*
 * CamoCrawl — original rendering-service module.
 * Part of CamoCrawl (Firecrawl + Camoufox backend), licensed under the
 * GNU Affero General Public License v3.0 or later; see root LICENSE.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Do not remove this header or any upstream copyright/license notices.
 */
import type { BrowserContext, Page, Request as PlaywrightRequest, Route } from 'playwright-core';
import type { ServiceConfig } from './config.js';
import type { Logger } from './logger.js';
import type { PageLease } from './pool.js';
import { InsecureConnectionError, assertSafeTargetUrl } from './ssrf.js';
import { getError } from './helpers/get_error.js';

export interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
  skip_tls_verification?: boolean;
}

export type ScrapeResult = {
  content: string;
  status: number | null;
  headers: Record<string, string> | null;
  contentType: string | undefined;
};

type ContextSecurityState = {
  blockedNavigationRequestUrl: string | null;
};

const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com',
];

type SeedCookie = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
};

/**
 * Cookie headers arrive without domain information, so they are applied to the
 * registrable domain (e.g. ".example.com") rather than as host-only cookies.
 * Authenticated pages frequently 302 across sibling subdomains
 * (example.com -> app.example.com); a host-only cookie would not be sent to
 * the redirect target and the request would land unauthenticated.
 */
const buildSeedCookies = (cookieHeader: string, url: string): SeedCookie[] => {
  let cookieDomain: string | undefined;
  try {
    const hostname = new URL(url).hostname;
    const labels = hostname.split('.');
    cookieDomain = labels.length > 2 ? labels.slice(-2).join('.') : hostname;
  } catch {
    cookieDomain = undefined;
  }

  const cookies: SeedCookie[] = [];
  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    cookies.push(
      cookieDomain
        ? { name, value, domain: `.${cookieDomain}`, path: '/' }
        : { name, value, url },
    );
  }
  return cookies;
};

/**
 * Applies request-scoped settings to a freshly created context.
 *
 * `skip_tls_verification` has to be set at context creation time in Playwright,
 * so the context is built here rather than by the pool.
 */
export const prepareContext = async (options: {
  context: BrowserContext;
  url: string;
  headers: Record<string, string> | undefined;
  config: ServiceConfig;
}): Promise<{ securityState: ContextSecurityState }> => {
  const { context, url, headers, config } = options;

  const securityState: ContextSecurityState = {
    blockedNavigationRequestUrl: null,
  };

  if (config.blockMedia) {
    await context.route(
      '**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}',
      async (route: Route) => {
        await route.abort();
      },
    );
  }

  await context.route('**/*', async (route: Route, request: PlaywrightRequest) => {
    const requestUrlString = request.url();
    try {
      await assertSafeTargetUrl(requestUrlString, config.allowLocalWebhooks);
    } catch (error) {
      if (error instanceof InsecureConnectionError) {
        if (request.isNavigationRequest()) {
          securityState.blockedNavigationRequestUrl = requestUrlString;
        }
        return route.abort('blockedbyclient');
      }
      throw error;
    }

    const hostname = new URL(requestUrlString).hostname.toLowerCase();
    if (AD_SERVING_DOMAINS.some(domain => hostname.includes(domain))) {
      return route.abort();
    }
    return route.continue();
  });

  // User-Agent is applied at the context level when the caller supplies one;
  // otherwise Camoufox's own spoofed UA is left alone, because overriding it
  // would desync the user agent from the rest of the fingerprint.
  const userAgentOverride = headers
    ? Object.entries(headers).find(([k]) => k.toLowerCase() === 'user-agent')?.[1]
    : undefined;
  if (userAgentOverride) {
    await context.setExtraHTTPHeaders({ 'user-agent': userAgentOverride });
  }

  return { securityState };
};

export const applyRequestHeaders = async (options: {
  context: BrowserContext;
  page: Page;
  url: string;
  headers: Record<string, string> | undefined;
  log: Logger;
}): Promise<void> => {
  const { context, page, url, headers, log } = options;
  if (!headers) return;

  // A Cookie header passed through setExtraHTTPHeaders is sent on the first
  // request but DROPPED on any redirect hop: the browser regenerates the
  // redirected request from its cookie jar, which is empty. Authenticated sites
  // that 302 (e.g. to /signin when the session looks absent) then land on the
  // login page. Seeding the jar instead makes the browser re-send it on every
  // request, including redirects, matching a raw HTTP client.
  const cookieHeader = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === 'cookie',
  )?.[1];
  if (cookieHeader) {
    const cookies = buildSeedCookies(cookieHeader, url);
    if (cookies.length > 0) {
      try {
        await context.addCookies(cookies);
      } catch (error) {
        log.warn('failed to seed cookies from Cookie header', { error });
      }
    }
  }

  // user-agent is already applied at the context level and Cookie is now in the
  // jar; forward everything else verbatim.
  const filteredHeaders = Object.fromEntries(
    Object.entries(headers).filter(([k]) => {
      const lower = k.toLowerCase();
      return lower !== 'user-agent' && lower !== 'cookie';
    }),
  );
  if (Object.keys(filteredHeaders).length > 0) {
    await page.setExtraHTTPHeaders(filteredHeaders);
  }
};

export const scrapePage = async (options: {
  page: Page;
  url: string;
  waitUntil: 'load' | 'networkidle';
  waitAfterLoad: number;
  timeout: number;
  checkSelector: string | undefined;
  securityState: ContextSecurityState;
  log: Logger;
}): Promise<ScrapeResult> => {
  const {
    page,
    url,
    waitUntil,
    waitAfterLoad,
    timeout,
    checkSelector,
    securityState,
    log,
  } = options;

  log.info('navigating', { url, waitUntil, timeout });

  let response;
  try {
    response = await page.goto(url, { waitUntil, timeout });
  } catch (error) {
    if (securityState.blockedNavigationRequestUrl) {
      throw new InsecureConnectionError(
        securityState.blockedNavigationRequestUrl,
        'navigation to private/internal resource is not allowed',
      );
    }
    throw error;
  }

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout });
    } catch {
      throw new Error('Required selector not found');
    }
  }

  let headers: Record<string, string> | null = null;
  let content = await page.content();
  let ct: string | undefined;

  if (response) {
    headers = await response.allHeaders();
    ct = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === 'content-type',
    )?.[1];
    if (
      ct &&
      (ct.toLowerCase().includes('application/json') ||
        ct.toLowerCase().includes('text/plain'))
    ) {
      content = (await response.body()).toString('utf8');
    }
  }

  return { content, status: response ? response.status() : null, headers, contentType: ct };
};

export const describeStatus = (status: number | null): string | undefined =>
  status !== 200 ? (getError(status) ?? undefined) : undefined;