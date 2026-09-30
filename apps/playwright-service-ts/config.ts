import { isLogLevel, type LogLevel } from './logger.js';

export type ProxyTarget = {
  /** Normalized `scheme://host:port` form, safe to hand to Playwright/Camoufox. */
  server: string;
  username: string | null;
  password: string | null;
};

export type Viewport = { width: number; height: number } | null;
export type WindowSize = [number, number];

export type CamoufoxConfig = {
  headless: boolean;
  os: string[] | undefined;
  locale: string[] | undefined;
  /** Aligns the fingerprint (timezone/locale/geo/WebRTC) with the proxy exit IP. */
  geoip: boolean;
  humanize: boolean | number;
  blockWebrtc: boolean;
  blockImages: boolean;
  blockServiceWorkers: boolean;
  /** Pins the spoofed window size. Undefined lets Camoufox pick a self-consistent one. */
  window: WindowSize | undefined;
  /** Playwright viewport override. `null` keeps the spoofed window size. */
  viewport: Viewport;
  enableCache: boolean;
  executablePath: string | undefined;
  firefoxUserPrefs: Record<string, unknown>;
  debug: boolean;
};

export type ServiceConfig = {
  port: number;
  logLevel: LogLevel;
  logScrapeRequests: boolean;
  blockMedia: boolean;
  allowLocalWebhooks: boolean;
  /** Hard cap on in-flight pages across the whole service. */
  maxConcurrentPages: number;
  /** Number of Camoufox instances kept warm. */
  poolSize: number;
  /** Max simultaneously open pages inside a single Camoufox instance. */
  pagesPerBrowser: number;
  /** Recycle a browser after it has served this many pages. */
  recyclePages: number;
  /** Recycle a browser once it has been alive for this long. */
  maxLifetimeMs: number;
  launchTimeoutMs: number;
  acquireTimeoutMs: number;
  relaunchBackoffMs: number;
  relaunchMaxBackoffMs: number;
  shutdownTimeoutMs: number;
  proxies: ProxyTarget[];
  camoufox: CamoufoxConfig;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const raw = (env: Env, key: string): string | undefined => {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const readBool = (env: Env, key: string, fallback: boolean): boolean => {
  const value = raw(env, key);
  if (value === undefined) return fallback;
  const normalized = value.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(
    `${key} must be a boolean (true/false), got "${value}"`,
  );
};

/** `auto` resolves lazily via `resolveGeoip`, so proxies can be parsed first. */
const readAutoBool = (
  env: Env,
  key: string,
): boolean | 'auto' | undefined => {
  const value = raw(env, key);
  if (value === undefined) return undefined;
  if (value.toLowerCase() === 'auto') return 'auto';
  return readBool(env, key, false);
};

const readInt = (
  env: Env,
  key: string,
  fallback: number,
  { min, max }: { min?: number; max?: number } = {},
): number => {
  const value = raw(env, key);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`${key} must be an integer, got "${value}"`);
  }
  if (min !== undefined && parsed < min) {
    throw new ConfigError(`${key} must be >= ${min}, got ${parsed}`);
  }
  if (max !== undefined && parsed > max) {
    throw new ConfigError(`${key} must be <= ${max}, got ${parsed}`);
  }
  return parsed;
};

const readList = (env: Env, key: string): string[] | undefined => {
  const value = raw(env, key);
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
};

const readJsonObject = (
  env: Env,
  key: string,
): Record<string, unknown> | undefined => {
  const value = raw(env, key);
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(
      `${key} must be a JSON object, got ${JSON.stringify(value)} (${(error as Error).message})`,
    );
  }
};

const readSize = (
  env: Env,
  key: string,
): { width: number; height: number } | undefined => {
  const value = raw(env, key);
  if (value === undefined) return undefined;
  const match = /^(\d{2,5})\s*[xX*]\s*(\d{2,5})$/.exec(value);
  if (!match) {
    throw new ConfigError(
      `${key} must look like WIDTHxHEIGHT (e.g. 1280x800), got "${value}"`,
    );
  }
  return { width: Number(match[1]), height: Number(match[2]) };
};

/**
 * Normalizes a proxy server into `scheme://host:port`. Playwright requires an
 * absolute URL here, and Camoufox parses the same string to look up the exit
 * IP, so the normalization has to happen once, up front.
 */
const DEFAULT_PROXY_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'socks:': '1080',
  'socks4:': '1080',
  'socks4a:': '1080',
  'socks5:': '1080',
  'socks5h:': '1080',
};

export const normalizeProxyServer = (server: string): string => {
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(server)
    ? server
    : `http://${server}`;
  const url = new URL(withScheme);
  if (!url.hostname) {
    throw new ConfigError(`Invalid proxy server "${server}"`);
  }

  const port = url.port || DEFAULT_PROXY_PORTS[url.protocol];
  if (!port) {
    throw new ConfigError(
      `Proxy server "${server}" must include a port for scheme ${url.protocol}`,
    );
  }

  // Built by hand rather than via `url.origin`: origin is null for
  // non-special schemes such as socks5://, and it drops default http(s) ports
  // that Playwright's Juggler proxy options expect to be explicit.
  return `${url.protocol}//${url.hostname}:${port}`;
};

/**
 * Parses the single-proxy environment variables kept for backwards
 * compatibility with the Chromium-based service.
 */
const parseLegacyProxy = (env: Env): ProxyTarget | null => {
  const server = raw(env, 'PROXY_SERVER');
  if (!server) return null;
  return {
    server: normalizeProxyServer(server),
    username: raw(env, 'PROXY_USERNAME') ?? null,
    password: raw(env, 'PROXY_PASSWORD') ?? null,
  };
};

/**
 * Parses `PROXY_SERVERS`, a `;`/newline separated list of
 * `server[|username|password]` entries. The pipe separator keeps generated
 * passwords (which routinely contain commas and colons) parseable.
 */
export const parseProxyList = (value: string): ProxyTarget[] =>
  value
    .split(/[;\n\r]+/)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [server, username, password] = entry.split('|');
      if (!server?.trim()) {
        throw new ConfigError(`PROXY_SERVERS entry "${entry}" has no server`);
      }
      return {
        server: normalizeProxyServer(server.trim()),
        username: username?.trim() || null,
        password: password?.trim() || null,
      };
    });

const parseProxies = (env: Env): ProxyTarget[] => {
  const list = raw(env, 'PROXY_SERVERS');
  if (list) {
    const parsed = parseProxyList(list);
    if (parsed.length === 0) {
      throw new ConfigError('PROXY_SERVERS was set but contained no entries');
    }
    return parsed;
  }
  const legacy = parseLegacyProxy(env);
  return legacy ? [legacy] : [];
};

export const redactProxy = (proxy: ProxyTarget | null): string => {
  if (!proxy) return 'none';
  return proxy.username ? `${proxy.server} (authenticated)` : proxy.server;
};

/** Builds the `scheme://user:pass@host:port` URL Camoufox uses for GeoIP lookups. */
export const proxyAuthUrl = (proxy: ProxyTarget): string => {
  const url = new URL(proxy.server);
  if (proxy.username) url.username = proxy.username;
  if (proxy.password) url.password = proxy.password;
  return url.toString();
};

const resolveGeoip = (
  env: Env,
  proxies: ProxyTarget[],
): boolean => {
  const configured = readAutoBool(env, 'CAMOUFOX_GEOIP');
  if (configured === 'auto' || configured === undefined) {
    // GeoIP without a proxy resolves our own (container) IP, which is both
    // useless and a slow external call on every launch.
    return proxies.length > 0;
  }
  return configured;
};

const parseHumanize = (env: Env): boolean | number => {
  const value = raw(env, 'CAMOUFOX_HUMANIZE');
  if (value === undefined) return false;
  if (value.toLowerCase() === 'false' || value === '0') return false;
  if (value.toLowerCase() === 'true' || value === '1') return true;
  const seconds = Number.parseFloat(value);
  if (Number.isNaN(seconds) || seconds < 0) {
    throw new ConfigError(
      `CAMOUFOX_HUMANIZE must be a boolean or a number of seconds, got "${value}"`,
    );
  }
  return seconds;
};

const DEFAULT_FIREFOX_PREFS: Record<string, unknown> = {
  // A headless scraper has no business phoning home or showing first-run UI.
  'app.update.auto': false,
  'app.update.enabled': false,
  'datareporting.healthreport.uploadEnabled': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'toolkit.telemetry.enabled': false,
  'toolkit.telemetry.unified': false,
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.page': 0,
  'browser.startup.homepage': 'about:blank',
  'browser.aboutwelcome.enabled': false,
  'browser.tabs.warnOnClose': false,
  'browser.sessionstore.resume_from_crash': false,
  'extensions.update.enabled': false,
  'extensions.blocklist.enabled': false,
  'services.settings.server': '',
  'network.captive-portal-service.enabled': false,
  'network.connectivity-service.enabled': false,
  'network.dns.disablePrefetch': false,
  'privacy.trackingprotection.enabled': false,
};

export const loadConfig = (env: Env = process.env): ServiceConfig => {
  const level = raw(env, 'LOG_LEVEL');
  if (level && !isLogLevel(level)) {
    throw new ConfigError(
      `LOG_LEVEL must be one of debug, info, warn, error — got "${level}"`,
    );
  }

  const proxies = parseProxies(env);
  const maxConcurrentPages = readInt(env, 'MAX_CONCURRENT_PAGES', 10, {
    min: 1,
  });
  const poolSize = readInt(env, 'CAMOUFOX_POOL_SIZE', 2, { min: 1 });
  const pagesPerBrowser = readInt(
    env,
    'CAMOUFOX_PAGES_PER_BROWSER',
    Math.max(1, Math.ceil(maxConcurrentPages / poolSize)),
    { min: 1 },
  );

  const viewportSetting = raw(env, 'CAMOUFOX_VIEWPORT');
  let viewport: Viewport = null;
  if (viewportSetting && viewportSetting.toLowerCase() !== 'null') {
    viewport =
      readSize(env, 'CAMOUFOX_VIEWPORT') ??
      (() => {
        throw new ConfigError('CAMOUFOX_VIEWPORT is not set correctly');
      })();
  }

  const windowSize = readSize(env, 'CAMOUFOX_WINDOW');
  const blockServiceWorkers = readBool(
    env,
    'CAMOUFOX_BLOCK_SERVICE_WORKERS',
    true,
  );

  return {
    port: readInt(env, 'PORT', 3000, { min: 0, max: 65535 }),
    logLevel: (level as LogLevel | undefined) ?? 'info',
    logScrapeRequests: readBool(env, 'LOG_SCRAPE_REQUESTS', true),
    blockMedia: readBool(env, 'BLOCK_MEDIA', false),
    allowLocalWebhooks: readBool(env, 'ALLOW_LOCAL_WEBHOOKS', false),
    maxConcurrentPages,
    poolSize,
    pagesPerBrowser,
    recyclePages: readInt(env, 'CAMOUFOX_RECYCLE_PAGES', 100, { min: 1 }),
    maxLifetimeMs: readInt(env, 'CAMOUFOX_MAX_LIFETIME_MS', 30 * 60 * 1000, {
      min: 1000,
    }),
    launchTimeoutMs: readInt(env, 'CAMOUFOX_LAUNCH_TIMEOUT_MS', 90_000, {
      min: 1000,
    }),
    acquireTimeoutMs: readInt(env, 'CAMOUFOX_ACQUIRE_TIMEOUT_MS', 30_000, {
      min: 100,
    }),
    relaunchBackoffMs: readInt(env, 'CAMOUFOX_RELAUNCH_BACKOFF_MS', 1000, {
      min: 10,
    }),
    relaunchMaxBackoffMs: readInt(
      env,
      'CAMOUFOX_RELAUNCH_BACKOFF_MAX_MS',
      30_000,
      { min: 100 },
    ),
    shutdownTimeoutMs: readInt(env, 'SHUTDOWN_TIMEOUT_MS', 20_000, {
      min: 1000,
    }),
    proxies,
    camoufox: {
      headless: readBool(env, 'CAMOUFOX_HEADLESS', true),
      os: readList(env, 'CAMOUFOX_OS'),
      locale: readList(env, 'CAMOUFOX_LOCALE'),
      geoip: resolveGeoip(env, proxies),
      humanize: parseHumanize(env),
      blockWebrtc: readBool(env, 'CAMOUFOX_BLOCK_WEBRTC', false),
      blockImages: readBool(env, 'CAMOUFOX_BLOCK_IMAGES', false),
      blockServiceWorkers,
      window: windowSize ? [windowSize.width, windowSize.height] : undefined,
      viewport,
      enableCache: readBool(env, 'CAMOUFOX_ENABLE_CACHE', false),
      executablePath: raw(env, 'CAMOUFOX_EXECUTABLE_PATH'),
      firefoxUserPrefs: {
        ...DEFAULT_FIREFOX_PREFS,
        ...(readJsonObject(env, 'CAMOUFOX_FIREFOX_PREFS') ?? {}),
        // Route interception in Firefox does not cover service worker traffic,
        // which would let a target page exfiltrate via a worker even though
        // every intercepted request was checked against the SSRF allowlist.
        // Firefox has no per-context equivalent of Playwright's
        // `serviceWorkers: "block"`, so it is enforced through a launch pref.
        ...(blockServiceWorkers ? { 'dom.serviceWorkers.enabled': false } : {}),
      },
      debug: readBool(env, 'CAMOUFOX_DEBUG', false),
    },
  };
};