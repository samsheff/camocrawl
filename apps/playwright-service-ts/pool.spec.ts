/*
 * CamoCrawl — original test module for the Camoufox rendering service.
 * Part of CamoCrawl (Firecrawl + Camoufox backend), licensed under the
 * GNU Affero General Public License v3.0 or later; see root LICENSE.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Do not remove this header or any upstream copyright/license notices.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CamoufoxPool } from './pool.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import * as camoufox from './camoufox.js';

type FakeBrowser = {
  on: ReturnType<typeof vi.fn>;
  newContext: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const makeFakeBrowser = (): FakeBrowser => ({
  on: vi.fn(),
  newContext: vi.fn(async () => ({
    newPage: vi.fn(async () => ({ id: 'page' })),
    close: vi.fn(async () => undefined),
    addCookies: vi.fn(async () => undefined),
    setExtraHTTPHeaders: vi.fn(async () => undefined),
    route: vi.fn(async () => undefined),
  })),
  close: vi.fn(async () => undefined),
});

const makeConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({
    CAMOUFOX_POOL_SIZE: '1',
    CAMOUFOX_PAGES_PER_BROWSER: '1',
    ...overrides,
  });

const log = createLogger('error', 'test');

describe('CamoufoxPool', () => {
  let launches: number;
  let browsers: FakeBrowser[];

  beforeEach(() => {
    launches = 0;
    browsers = [];
    vi.spyOn(camoufox, 'launchCamoufox').mockImplementation(async () => {
      launches += 1;
      const browser = makeFakeBrowser();
      browsers.push(browser);
      return {
        browser: browser as never,
        guardPort: 40000 + launches,
        fingerprint: `fp-${launches}`,
        close: async () => {
          await browser.close();
        },
      };
    });
  });

  it('launches one browser per pool slot', async () => {
    const pool = new CamoufoxPool(makeConfig({ CAMOUFOX_POOL_SIZE: '3' }), log);
    await pool.start();
    expect(launches).toBe(3);
    expect(pool.stats().ready).toBe(3);
    await pool.close();
  });

  it('fails to start when no browser can be launched', async () => {
    vi.spyOn(camoufox, 'launchCamoufox').mockRejectedValue(new Error('boom'));
    const pool = new CamoufoxPool(makeConfig(), log);
    await expect(pool.start()).rejects.toThrow(/Failed to launch any Camoufox/);
    await pool.close();
  });

  it('serves traffic when only some slots come up', async () => {
    let call = 0;
    vi.spyOn(camoufox, 'launchCamoufox').mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error('proxy unreachable');
      const browser = makeFakeBrowser();
      return {
        browser: browser as never,
        guardPort: 50000 + call,
        fingerprint: `fp-${call}`,
        close: async () => undefined,
      };
    });

    const pool = new CamoufoxPool(makeConfig({ CAMOUFOX_POOL_SIZE: '2' }), log);
    await pool.start();
    expect(pool.hasHealthyBrowser()).toBe(true);
    const lease = await pool.acquire();
    expect(lease.fingerprint).toBe('fp-2');
    await lease.release();
    await pool.close();
  });

  it('hands out a fresh context per scrape and reclaims it on release', async () => {
    const pool = new CamoufoxPool(makeConfig(), log);
    await pool.start();

    const lease = await pool.acquire();
    expect(browsers[0].newContext).toHaveBeenCalledTimes(1);
    expect(pool.stats().activePages).toBe(1);

    await lease.release();
    expect(pool.stats().activePages).toBe(0);
    await pool.close();
  });

  it('is idempotent on release', async () => {
    const pool = new CamoufoxPool(makeConfig(), log);
    await pool.start();
    const lease = await pool.acquire();
    await lease.release();
    await lease.release();
    expect(pool.stats().activePages).toBe(0);
    await pool.close();
  });

  it('times out instead of queueing forever when saturated', async () => {
    const pool = new CamoufoxPool(makeConfig(), log);
    await pool.start();

    const held = await pool.acquire();
    await expect(pool.acquire({ timeoutMs: 200 })).rejects.toThrow(
      /Timed out after 200ms/,
    );
    await held.release();
    await pool.close();
  });

  it('recycles the browser after the configured page budget', async () => {
    const pool = new CamoufoxPool(
      makeConfig({ CAMOUFOX_RECYCLE_PAGES: '2' }),
      log,
    );
    await pool.start();

    for (let i = 0; i < 2; i++) {
      const lease = await pool.acquire();
      await lease.release();
    }

    // The relaunch happens on the supervisor, so give it a turn to run.
    await vi.waitFor(() => expect(launches).toBe(2), { timeout: 2000 });
    expect(pool.stats().totalRecycles).toBeGreaterThanOrEqual(1);
    await pool.close();
  });

  it('does not recycle mid-scrape', async () => {
    const pool = new CamoufoxPool(
      makeConfig({ CAMOUFOX_RECYCLE_PAGES: '1' }),
      log,
    );
    await pool.start();

    const lease = await pool.acquire();
    // Budget is exhausted but the page is still open: the browser must stay up.
    await new Promise(r => setTimeout(r, 100));
    expect(launches).toBe(1);
    expect(pool.stats().ready).toBe(1);

    await lease.release();
    await vi.waitFor(() => expect(launches).toBe(2), { timeout: 2000 });
    await pool.close();
  });

  it('replaces a browser reported as crashed', async () => {
    const pool = new CamoufoxPool(makeConfig(), log);
    await pool.start();

    const lease = await pool.acquire();
    lease.markUnhealthy('crash detected');
    await lease.release();

    await vi.waitFor(() => expect(launches).toBe(2), { timeout: 2000 });
    expect(pool.hasHealthyBrowser()).toBe(true);
    await pool.close();
  });

  it('replaces a browser that disconnects on its own', async () => {
    const pool = new CamoufoxPool(makeConfig(), log);
    await pool.start();

    // Simulate the crash notification Playwright emits.
    const handler = browsers[0].on.mock.calls[0][1];
    handler();

    await vi.waitFor(() => expect(launches).toBe(2), { timeout: 2000 });
    await pool.close();
  });

  it('closes every browser on shutdown', async () => {
    const pool = new CamoufoxPool(makeConfig({ CAMOUFOX_POOL_SIZE: '2' }), log);
    await pool.start();
    await pool.close();

    expect(browsers.every(b => b.close.mock.calls.length > 0)).toBe(true);
    await expect(pool.acquire({ timeoutMs: 100 })).rejects.toThrow(/shutting down/);
  });

  it('gives each slot its own proxy so fingerprints stay aligned per exit IP', async () => {
    const pool = new CamoufoxPool(
      makeConfig({
        CAMOUFOX_POOL_SIZE: '2',
        PROXY_SERVERS: 'http://a:1;http://b:2',
      }),
      log,
    );
    await pool.start();

    expect(pool.stats().slots.map(s => s.proxy)).toEqual([
      'http://a:1',
      'http://b:2',
    ]);
    await pool.close();
  });
});