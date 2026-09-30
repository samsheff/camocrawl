import { describe, expect, it, vi } from 'vitest';
import {
  applyRequestHeaders,
  describeStatus,
  prepareContext,
  scrapePage,
} from './scrape.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('error', 'test');
const config = loadConfig({});

const makeContext = (overrides: Record<string, unknown> = {}) => ({
  route: vi.fn(async () => undefined),
  addCookies: vi.fn(async () => undefined),
  setExtraHTTPHeaders: vi.fn(async () => undefined),
  ...overrides,
});

const makePage = (overrides: Record<string, unknown> = {}) => ({
  goto: vi.fn(async () => ({
    status: () => 200,
    allHeaders: async () => ({ 'content-type': 'text/html' }),
    body: async () => Buffer.from(''),
  })),
  content: vi.fn(async () => '<html>ok</html>'),
  waitForTimeout: vi.fn(async () => undefined),
  waitForSelector: vi.fn(async () => undefined),
  setExtraHTTPHeaders: vi.fn(async () => undefined),
  ...overrides,
});

const noSecurityState = { blockedNavigationRequestUrl: null };

describe('prepareContext', () => {
  it('blocks requests to private addresses', async () => {
    const context = makeContext();
    await prepareContext({
      context: context as never,
      url: 'https://example.com',
      headers: undefined,
      config,
    });

    const routeHandler = context.route.mock.calls[0][1] as (
      route: unknown,
      request: unknown,
    ) => Promise<void>;

    const abort = vi.fn(async () => undefined);
    await routeHandler(
      { abort, continue: vi.fn() },
      {
        url: () => 'http://169.254.169.254/latest/meta-data/',
        isNavigationRequest: () => false,
      },
    );
    expect(abort).toHaveBeenCalledWith('blockedbyclient');
  });

  it('aborts known ad-serving domains', async () => {
    const context = makeContext();
    await prepareContext({
      context: context as never,
      url: 'https://example.com',
      headers: undefined,
      config,
    });

    const routeHandler = context.route.mock.calls[0][1] as (
      route: unknown,
      request: unknown,
    ) => Promise<void>;

    const abort = vi.fn(async () => undefined);
    const cont = vi.fn(async () => undefined);
    await routeHandler(
      { abort, continue: cont },
      {
        url: () => 'https://doubleclick.net/ad.js',
        isNavigationRequest: () => false,
      },
    );
    expect(abort).toHaveBeenCalled();
    expect(cont).not.toHaveBeenCalled();
  });

  it('allows everything else through', async () => {
    const context = makeContext();
    await prepareContext({
      context: context as never,
      url: 'https://example.com',
      headers: undefined,
      config,
    });

    const routeHandler = context.route.mock.calls[0][1] as (
      route: unknown,
      request: unknown,
    ) => Promise<void>;

    const cont = vi.fn(async () => undefined);
    await routeHandler(
      { abort: vi.fn(async () => undefined), continue: cont },
      {
        url: () => 'https://example.com/app.js',
        isNavigationRequest: () => false,
      },
    );
    expect(cont).toHaveBeenCalled();
  });
});

describe('applyRequestHeaders', () => {
  it('seeds cookies on the registrable domain so redirects stay authenticated', async () => {
    const context = makeContext();
    await applyRequestHeaders({
      context: context as never,
      page: makePage() as never,
      url: 'https://app.example.com/start',
      headers: { Cookie: 'session=abc; other=def' },
      log,
    });

    expect(context.addCookies).toHaveBeenCalledWith([
      { name: 'session', value: 'abc', domain: '.example.com', path: '/' },
      { name: 'other', value: 'def', domain: '.example.com', path: '/' },
    ]);
  });

  it('strips user-agent and cookie from the forwarded headers', async () => {
    const page = makePage();
    const context = makeContext();
    await applyRequestHeaders({
      context: context as never,
      page: page as never,
      url: 'https://example.com',
      headers: {
        Cookie: 'a=1',
        'User-Agent': 'custom',
        'X-Custom': 'kept',
      },
      log,
    });

    expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith({ 'X-Custom': 'kept' });
  });

  it('applies a caller-supplied user agent at the context level', async () => {
    const context = makeContext();
    await prepareContext({
      context: context as never,
      url: 'https://example.com',
      headers: { 'user-agent': 'my-bot/1.0' },
      config,
    });
    expect(context.setExtraHTTPHeaders).toHaveBeenCalledWith({
      'user-agent': 'my-bot/1.0',
    });
  });

  it('leaves the Camoufox user agent alone when none is supplied', async () => {
    const context = makeContext();
    await prepareContext({
      context: context as never,
      url: 'https://example.com',
      headers: { 'X-Custom': 'kept' },
      config,
    });
    expect(context.setExtraHTTPHeaders).not.toHaveBeenCalled();
  });
});

describe('scrapePage', () => {
  it('returns rendered HTML with the response status', async () => {
    const page = makePage();
    const result = await scrapePage({
      page: page as never,
      url: 'https://example.com',
      waitUntil: 'load',
      waitAfterLoad: 0,
      timeout: 5000,
      checkSelector: undefined,
      securityState: noSecurityState,
      log,
    });

    expect(result.content).toBe('<html>ok</html>');
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/html');
  });

  it('returns the raw body for JSON responses', async () => {
    const page = makePage({
      goto: vi.fn(async () => ({
        status: () => 200,
        allHeaders: async () => ({ 'content-type': 'application/json' }),
        body: async () => Buffer.from('{"a":1}'),
      })),
    });

    const result = await scrapePage({
      page: page as never,
      url: 'https://example.com/api',
      waitUntil: 'load',
      waitAfterLoad: 0,
      timeout: 5000,
      checkSelector: undefined,
      securityState: noSecurityState,
      log,
    });

    expect(result.content).toBe('{"a":1}');
  });

  it('waits after load when requested', async () => {
    const page = makePage();
    await scrapePage({
      page: page as never,
      url: 'https://example.com',
      waitUntil: 'load',
      waitAfterLoad: 2000,
      timeout: 15000,
      checkSelector: undefined,
      securityState: noSecurityState,
      log,
    });
    expect(page.waitForTimeout).toHaveBeenCalledWith(2000);
  });

  it('waits for a required selector', async () => {
    const page = makePage();
    await scrapePage({
      page: page as never,
      url: 'https://example.com',
      waitUntil: 'load',
      waitAfterLoad: 0,
      timeout: 5000,
      checkSelector: '#content',
      securityState: noSecurityState,
      log,
    });
    expect(page.waitForSelector).toHaveBeenCalledWith('#content', {
      timeout: 5000,
    });
  });

  it('raises when the required selector is missing', async () => {
    const page = makePage({
      waitForSelector: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });

    await expect(
      scrapePage({
        page: page as never,
        url: 'https://example.com',
        waitUntil: 'load',
        waitAfterLoad: 0,
        timeout: 1000,
        checkSelector: '#nope',
        securityState: noSecurityState,
        log,
      }),
    ).rejects.toThrow('Required selector not found');
  });

  it('surfaces a blocked navigation as an SSRF error', async () => {
    const page = makePage({
      goto: vi.fn(async () => {
        throw new Error('net::ERR_BLOCKED_BY_CLIENT');
      }),
    });

    await expect(
      scrapePage({
        page: page as never,
        url: 'https://example.com',
        waitUntil: 'load',
        waitAfterLoad: 0,
        timeout: 1000,
        checkSelector: undefined,
        securityState: { blockedNavigationRequestUrl: 'http://10.0.0.1/' },
        log,
      }),
    ).rejects.toThrow(/Blocked insecure target URL/);
  });
});

describe('describeStatus', () => {
  it('has no error for 200', () => {
    expect(describeStatus(200)).toBeUndefined();
  });

  it('names common error statuses', () => {
    expect(describeStatus(404)).toBe('Not Found');
    expect(describeStatus(403)).toBe('Forbidden');
    expect(describeStatus(null)).toBe('No response received');
  });
});

