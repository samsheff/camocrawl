import express, { type Request, type Response } from 'express';
import dotenv from 'dotenv';
import { pathToFileURL } from 'url';
import { loadConfig, type ServiceConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { CamoufoxPool, type PageLease } from './pool.js';
import { InsecureConnectionError, assertSafeTargetUrl } from './ssrf.js';
import {
  applyRequestHeaders,
  describeStatus,
  prepareContext,
  scrapePage,
  type UrlModel,
} from './scrape.js';

dotenv.config();

const DEFAULT_TIMEOUT_MS = 15000;

export const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch {
    return false;
  }
};

type Deps = {
  config: ServiceConfig;
  log: Logger;
  pool: CamoufoxPool;
};

const blockedResponse = (res: Response, error: InsecureConnectionError) =>
  res.json({
    content: '',
    pageStatusCode: 403,
    pageError: error.message,
  });

export const createApp = ({ config, log, pool }: Deps): express.Express => {
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req: Request, res: Response) => {
    const stats = pool.stats();
    try {
      if (!pool.hasHealthyBrowser()) {
        throw new Error('No healthy Camoufox browser is available');
      }
      res.status(200).json({
        status: 'healthy',
        // Retained for backwards compatibility with existing health checks.
        maxConcurrentPages: config.maxConcurrentPages,
        activePages: stats.activePages,
        engine: 'camoufox',
        pool: stats,
      });
    } catch (error) {
      log.error('Health check failed', { error, pool: stats });
      res.status(503).json({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        pool: stats,
      });
    }
  });

  app.post('/scrape', async (req: Request, res: Response) => {
    const {
      url,
      wait_after_load = 0,
      timeout = DEFAULT_TIMEOUT_MS,
      headers,
      check_selector,
      skip_tls_verification = false,
    }: UrlModel = req.body ?? {};

    if (config.logScrapeRequests) {
      log.info('scrape request', {
        url,
        waitAfterLoad: wait_after_load,
        timeout,
        hasHeaders: !!headers,
        checkSelector: check_selector,
        skipTlsVerification: skip_tls_verification,
      });
    }

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    if (!isValidUrl(url)) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    try {
      await assertSafeTargetUrl(url, config.allowLocalWebhooks);
    } catch (error) {
      if (error instanceof InsecureConnectionError) {
        return blockedResponse(res, error);
      }
      throw error;
    }

    let lease: PageLease | null = null;
    try {
      lease = await pool.acquire({ ignoreHTTPSErrors: skip_tls_verification });

      const requestLog = log.child(`slot${lease.slotId}`);
      const { securityState } = await prepareContext({
        context: lease.context,
        url,
        headers,
        config,
      });

      await applyRequestHeaders({
        context: lease.context,
        page: lease.page,
        url,
        headers,
        log: requestLog,
      });

      const result = await scrapePage({
        page: lease.page,
        url,
        waitUntil: 'load',
        waitAfterLoad: wait_after_load,
        timeout,
        checkSelector: check_selector,
        securityState,
        log: requestLog,
      });

      const pageError = describeStatus(result.status);
      if (pageError) {
        requestLog.info('scrape returned an error status', {
          status: result.status,
          pageError,
        });
      }

      res.json({
        content: result.content,
        pageStatusCode: result.status,
        contentType: result.contentType,
        ...(pageError && { pageError }),
      });
    } catch (error) {
      if (error instanceof InsecureConnectionError) {
        return blockedResponse(res, error);
      }

      // A dead browser would otherwise poison the slot for every subsequent
      // request, so it is replaced rather than reused.
      if (isBrowserFailure(error)) {
        lease?.markUnhealthy(`scrape failed: ${describeError(error)}`);
        log.error('Browser failure during scrape', { error });
        return res.status(502).json({
          error: 'Browser instance failed while fetching the page.',
        });
      }

      log.error('Scrape error', { error });
      res
        .status(500)
        .json({ error: 'An error occurred while fetching the page.' });
    } finally {
      if (lease) await lease.release().catch(() => undefined);
    }
  });

  return app;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Distinguishes a dead browser from an ordinary scrape failure (bad selector,
 * navigation timeout, HTTP error). Only the former invalidates the slot.
 */
const isBrowserFailure = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return /browser has been closed|browser closed|Target closed|Target page, context or browser has been closed|Connection closed|Protocol error|WebSocket|ECONNRESET|EPIPE|pipe closed|target closed/i.test(
    `${error.message}\n${(error.cause as Error | undefined)?.message ?? ''}`,
  );
};

export const start = async (): Promise<{
  app: express.Express;
  close: () => Promise<void>;
}> => {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const pool = new CamoufoxPool(config, log);

  if (config.proxies.length === 0) {
    log.warn(
      'No proxy server provided. Scraper IP address may be blocked by target sites.',
    );
  }
  const capacity = pool.capacity;
  if (capacity < config.maxConcurrentPages) {
    log.info(
      `Camoufox pool capacity is ${capacity} concurrent pages (${config.poolSize} x ${config.pagesPerBrowser}); scrapes above that wait for a free browser`,
    );
  }

  await pool.start();
  log.info('camoufox pool ready', { pool: pool.stats() });

  const app = createApp({ config, log, pool });
  const server = app.listen(config.port, () => {
    log.info(`Server is running on port ${config.port}`);
  });

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      log.info('shutting down');
      // Stop accepting new connections first so in-flight scrapes can finish
      // rather than being cut off when the socket closes.
      await new Promise<void>(resolve => server.close(() => resolve()));
      const warnTimer = setTimeout(() => {
        log.warn('shutdown exceeded its budget; closing browsers anyway');
      }, config.shutdownTimeoutMs);
      warnTimer.unref?.();
      await pool.close();
      clearTimeout(warnTimer);
      log.info('shutdown complete');
    })();
    return closing;
  };

  // Playwright's own signal handling is disabled at launch (see camoufox.ts) so
  // that these handlers own teardown and every browser is closed deterministically.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info(`received ${signal}`);
      close()
        .then(() => process.exit(0))
        .catch(error => {
          log.error('error during shutdown', { error });
          process.exit(1);
        });
    });
  }

  return { app, close };
};

// Started as a program rather than imported by a test.
const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  start().catch(error => {
    createLogger('error').error('Failed to start server', { error });
    process.exit(1);
  });
}