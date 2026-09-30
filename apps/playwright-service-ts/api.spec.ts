import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './api.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import type { CamoufoxPool, PageLease } from './pool.js';
import * as scrape from './scrape.js';

const log = createLogger('error', 'test');

const makeLease = (overrides: Partial<PageLease> = {}): PageLease => ({
  slotId: 0,
  fingerprint: 'linux-en-US',
  browser: {} as never,
  context: {} as never,
  page: {} as never,
  release: vi.fn(async () => undefined),
  markUnhealthy: vi.fn(),
  ...overrides,
});

const makePool = (lease: PageLease | (() => Promise<PageLease>)): CamoufoxPool =>
  ({
    acquire: vi.fn(async () => (typeof lease === 'function' ? lease() : lease)),
    stats: vi.fn(() => ({
      poolSize: 1,
      ready: 1,
      starting: 0,
      activePages: 0,
      capacity: 1,
      totalScrapes: 0,
      totalRecycles: 0,
      slots: [],
    })),
    hasHealthyBrowser: vi.fn(() => true),
    close: vi.fn(async () => undefined),
  }) as unknown as CamoufoxPool;

let scrapePageSpy: ReturnType<typeof vi.spyOn>;
let prepareContextSpy: ReturnType<typeof vi.spyOn>;
let applyHeadersSpy: ReturnType<typeof vi.spyOn>;

const okResult = {
  content: '<html>hello</html>',
  status: 200,
  headers: { 'content-type': 'text/html' },
  contentType: 'text/html',
};

beforeEach(() => {
  scrapePageSpy = vi.spyOn(scrape, 'scrapePage').mockResolvedValue(okResult);
  prepareContextSpy = vi
    .spyOn(scrape, 'prepareContext')
    .mockResolvedValue({ securityState: { blockedNavigationRequestUrl: null } });
  applyHeadersSpy = vi
    .spyOn(scrape, 'applyRequestHeaders')
    .mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const appWith = (pool: CamoufoxPool, env: Record<string, string> = {}) =>
  createApp({ config: loadConfig(env), log, pool });

describe('POST /scrape', () => {
  it('returns content and status for a successful scrape', async () => {
    const lease = makeLease();
    const res = await request(appWith(makePool(lease)))
      .post('/scrape')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      content: '<html>hello</html>',
      pageStatusCode: 200,
      contentType: 'text/html',
    });
    expect(lease.release).toHaveBeenCalled();
  });

  it('passes the scrape options through to the browser layer', async () => {
    const lease = makeLease();
    await request(appWith(makePool(lease)))
      .post('/scrape')
      .send({
        url: 'https://example.com',
        wait_after_load: 1500,
        timeout: 9000,
        headers: { 'X-Custom': 'v' },
        check_selector: '#main',
        skip_tls_verification: true,
      });

    expect(scrapePageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com',
        waitAfterLoad: 1500,
        timeout: 9000,
        checkSelector: '#main',
      }),
    );
    expect(applyHeadersSpy).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'X-Custom': 'v' } }),
    );
  });

  it('requests an HTTPS-error-tolerant context when asked', async () => {
    const pool = makePool(makeLease());
    await request(appWith(pool))
      .post('/scrape')
      .send({ url: 'https://self-signed.badssl.com', skip_tls_verification: true });

    expect(pool.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreHTTPSErrors: true }),
    );
  });

  it('rejects a missing URL', async () => {
    const res = await request(appWith(makePool(makeLease())))
      .post('/scrape')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('URL is required');
  });

  it('rejects a malformed URL', async () => {
    const res = await request(appWith(makePool(makeLease())))
      .post('/scrape')
      .send({ url: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid URL');
  });

  it('blocks private-network targets without touching the browser', async () => {
    const lease = makeLease();
    const res = await request(appWith(makePool(lease)))
      .post('/scrape')
      .send({ url: 'http://169.254.169.254/latest/meta-data/' });

    expect(res.status).toBe(200);
    expect(res.body.pageStatusCode).toBe(403);
    expect(res.body.pageError).toContain('Blocked insecure target URL');
    expect(scrapePageSpy).not.toHaveBeenCalled();
  });

  it('allows private-network targets when ALLOW_LOCAL_WEBHOOKS is on', async () => {
    const lease = makeLease();
    const res = await request(
      appWith(makePool(lease), { ALLOW_LOCAL_WEBHOOKS: 'true' }),
    )
      .post('/scrape')
      .send({ url: 'http://127.0.0.1:4321/' });

    expect(res.status).toBe(200);
    expect(scrapePageSpy).toHaveBeenCalled();
  });

  it('reports the target status code without failing the request', async () => {
    scrapePageSpy.mockResolvedValue({
      content: '',
      status: 404,
      headers: {},
      contentType: 'text/html',
    });

    const res = await request(appWith(makePool(makeLease())))
      .post('/scrape')
      .send({ url: 'https://example.com/missing' });

    expect(res.status).toBe(200);
    expect(res.body.pageStatusCode).toBe(404);
    expect(res.body.pageError).toBe('Not Found');
  });

  it('releases the lease even when the scrape throws', async () => {
    const lease = makeLease();
    scrapePageSpy.mockRejectedValue(new Error('Required selector not found'));

    const res = await request(appWith(makePool(lease)))
      .post('/scrape')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(500);
    expect(lease.release).toHaveBeenCalled();
    // A scrape-level failure does not condemn the browser.
    expect(lease.markUnhealthy).not.toHaveBeenCalled();
  });

  it('marks the browser unhealthy and returns 502 when the browser dies', async () => {
    const lease = makeLease();
    scrapePageSpy.mockRejectedValue(
      new Error('Target page, context or browser has been closed'),
    );

    const res = await request(appWith(makePool(lease)))
      .post('/scrape')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(502);
    expect(lease.markUnhealthy).toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalled();
  });

  it('returns 500 when the pool has no capacity', async () => {
    const pool = makePool(async () => {
      throw new Error('Timed out after 30000ms waiting for a free Camoufox browser');
    });
    const res = await request(appWith(pool))
      .post('/scrape')
      .send({ url: 'https://example.com' });
    expect(res.status).toBe(500);
  });
});

describe('GET /health', () => {
  it('reports pool health while keeping the legacy fields', async () => {
    const res = await request(appWith(makePool(makeLease()), {
      MAX_CONCURRENT_PAGES: '7',
    })).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.maxConcurrentPages).toBe(7);
    expect(res.body.engine).toBe('camoufox');
    expect(res.body.pool.poolSize).toBe(1);
  });

  it('reports 503 when no browser is usable', async () => {
    const pool = makePool(makeLease());
    (pool.hasHealthyBrowser as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const res = await request(appWith(pool)).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
  });
});