import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  normalizeProxyServer,
  parseProxyList,
  proxyAuthUrl,
  redactProxy,
} from './config.js';

const base = { MAX_CONCURRENT_PAGES: '10', CAMOUFOX_POOL_SIZE: '2' } as const;

describe('normalizeProxyServer', () => {
  it('adds a scheme and a default port', () => {
    expect(normalizeProxyServer('proxy.example.com')).toBe(
      'http://proxy.example.com:80',
    );
    expect(normalizeProxyServer('http://proxy.example.com')).toBe(
      'http://proxy.example.com:80',
    );
    expect(normalizeProxyServer('https://proxy.example.com')).toBe(
      'https://proxy.example.com:443',
    );
    // socks5:// is not a "special" scheme, so URL.origin would drop the port.
    expect(normalizeProxyServer('socks5://proxy.example.com')).toBe(
      'socks5://proxy.example.com:1080',
    );
  });

  it('keeps an explicit port', () => {
    expect(normalizeProxyServer('10.0.0.1:8080')).toBe('http://10.0.0.1:8080');
  });

  it('strips credentials embedded in the server string', () => {
    expect(normalizeProxyServer('http://user:pass@proxy.example.com:8080')).toBe(
      'http://proxy.example.com:8080',
    );
  });
});

describe('parseProxyList', () => {
  it('parses pipe-delimited credentials per entry', () => {
    const parsed = parseProxyList(
      'http://a.example.com:8000|user1|pass1;http://b.example.com:8001|user2|pass2',
    );
    expect(parsed).toEqual([
      { server: 'http://a.example.com:8000', username: 'user1', password: 'pass1' },
      { server: 'http://b.example.com:8001', username: 'user2', password: 'pass2' },
    ]);
  });

  it('accepts newlines as separators', () => {
    const parsed = parseProxyList('http://a:1\nhttp://b:2');
    expect(parsed.map(p => p.server)).toEqual(['http://a:1', 'http://b:2']);
  });

  it('keeps commas inside passwords', () => {
    const [proxy] = parseProxyList('http://a:1|user|pa,ss,word');
    expect(proxy.password).toBe('pa,ss,word');
  });
});

describe('redactProxy / proxyAuthUrl', () => {
  it('never exposes credentials in logs', () => {
    const [proxy] = parseProxyList('http://a:1|user|secret');
    expect(redactProxy(proxy)).toBe('http://a:1 (authenticated)');
    expect(redactProxy(null)).toBe('none');
  });

  it('builds an authenticated URL for GeoIP lookups', () => {
    const [proxy] = parseProxyList('http://a:1|user|secret');
    expect(proxyAuthUrl(proxy)).toBe('http://user:secret@a:1/');
  });
});

describe('loadConfig', () => {
  it('derives pages per browser from the concurrency budget', () => {
    const config = loadConfig({ MAX_CONCURRENT_PAGES: '10', CAMOUFOX_POOL_SIZE: '2' });
    expect(config.pagesPerBrowser).toBe(5);
  });

  it('never computes a zero page budget', () => {
    const config = loadConfig({ MAX_CONCURRENT_PAGES: '1', CAMOUFOX_POOL_SIZE: '8' });
    expect(config.pagesPerBrowser).toBe(1);
  });

  it('enables GeoIP only when a proxy is configured', () => {
    expect(loadConfig({}).camoufox.geoip).toBe(false);
    expect(
      loadConfig({ PROXY_SERVER: 'http://proxy.example.com:8080' }).camoufox.geoip,
    ).toBe(true);
  });

  it('honours an explicit GeoIP override', () => {
    expect(loadConfig({ CAMOUFOX_GEOIP: 'false', PROXY_SERVER: 'http://p:1' }).camoufox.geoip).toBe(false);
    expect(loadConfig({ CAMOUFOX_GEOIP: 'true' }).camoufox.geoip).toBe(true);
  });

  it('prefers PROXY_SERVERS over the single-proxy variables', () => {
    const config = loadConfig({
      PROXY_SERVER: 'http://legacy:1',
      PROXY_SERVERS: 'http://a:1;http://b:2',
    });
    expect(config.proxies.map(p => p.server)).toEqual(['http://a:1', 'http://b:2']);
  });

  it('disables service workers by default to keep route interception authoritative', () => {
    expect(loadConfig({}).camoufox.firefoxUserPrefs['dom.serviceWorkers.enabled']).toBe(false);
    expect(
      loadConfig({ CAMOUFOX_BLOCK_SERVICE_WORKERS: 'false' }).camoufox.firefoxUserPrefs[
        'dom.serviceWorkers.enabled'
      ],
    ).toBeUndefined();
  });

  it('parses WIDTHxHEIGHT viewport and window', () => {
    const config = loadConfig({ CAMOUFOX_VIEWPORT: '1280x800', CAMOUFOX_WINDOW: '1440x900' });
    expect(config.camoufox.viewport).toEqual({ width: 1280, height: 800 });
    expect(config.camoufox.window).toEqual([1440, 900]);
  });

  it('defaults the viewport to null so Camoufox controls geometry', () => {
    expect(loadConfig({}).camoufox.viewport).toBeNull();
    expect(loadConfig({ CAMOUFOX_VIEWPORT: 'null' }).camoufox.viewport).toBeNull();
  });

  it('rejects malformed values instead of silently defaulting', () => {
    expect(() => loadConfig({ MAX_CONCURRENT_PAGES: 'many' })).toThrow(ConfigError);
    expect(() => loadConfig({ BLOCK_MEDIA: 'maybe' })).toThrow(ConfigError);
    expect(() => loadConfig({ CAMOUFOX_VIEWPORT: 'wide' })).toThrow(ConfigError);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(ConfigError);
    expect(() => loadConfig({ CAMOUFOX_FIREFOX_PREFS: 'nope' })).toThrow(ConfigError);
  });
});