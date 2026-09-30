/*
 * CamoCrawl — original rendering-service module.
 * Part of CamoCrawl (Firecrawl + Camoufox backend), licensed under the
 * GNU Affero General Public License v3.0 or later; see root LICENSE.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Do not remove this header or any upstream copyright/license notices.
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { ProxyTarget, ServiceConfig } from './config.js';
import { redactProxy } from './config.js';
import { launchCamoufox, type CamoufoxBrowser } from './camoufox.js';
import type { Logger } from './logger.js';

/**
 * A leased browser plus the context/page carved out of it for one scrape.
 *
 * `release` is mandatory: forgetting it leaks a context and pins the browser
 * as busy, which drains the pool.
 */
export type PageLease = {
  slotId: number;
  fingerprint: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Releases the context and hands the slot back to the pool. Idempotent. */
  release: () => Promise<void>;
  /**
   * Reports a browser-level failure (crash, closed pipe). The slot is torn down
   * and replaced, so the caller does not need to distinguish these.
   */
  markUnhealthy: (reason: string) => void;
};

type SlotState = 'starting' | 'ready' | 'stopped';

type Slot = {
  id: number;
  proxy: ProxyTarget | null;
  state: SlotState;
  instance: CamoufoxBrowser | null;
  pagesServed: number;
  createdAt: number;
  activePages: number;
  /** Pending background work (relaunch / recycle) for this slot. */
  work: Promise<void> | null;
  recycleRequested: boolean;
  recycleReason: string | null;
  /** Bumped on every launch so superseded async work can detect it lost a race. */
  generation: number;
  /** Consecutive failed launches, used for backoff. */
  launchFailures: number;
};

export type SlotStats = {
  id: number;
  state: SlotState;
  fingerprint: string | null;
  proxy: string;
  pagesServed: number;
  activePages: number;
  ageMs: number;
  recycleRequested: boolean;
};

export type PoolStats = {
  poolSize: number;
  ready: number;
  starting: number;
  activePages: number;
  capacity: number;
  totalScrapes: number;
  totalRecycles: number;
  slots: SlotStats[];
};

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * A fixed-size pool of Camoufox instances, each pinned to its own proxy and
 * fingerprint.
 *
 * Design notes:
 * - `acquire` never blocks forever. When the pool is saturated it fails fast
 *   so the HTTP layer can return a real status instead of holding a request
 *   open past Firecrawl's scrape timeout.
 * - Recycling is cooperative. An instance that reaches its page or age limit
 *   is torn down only after its in-flight pages finish, so a long scrape is
 *   never cut off mid-flight.
 * - A crashed browser is replaced by a background supervisor rather than by
 *   the request that noticed it, which keeps one crash from cascading.
 */
export class CamoufoxPool {
  readonly #config: ServiceConfig;
  readonly #log: Logger;
  readonly #slots: Slot[] = [];
  readonly #waiters = new Set<() => void>();
  #closed = false;
  #started = false;
  #totalScrapes = 0;
  #totalRecycles = 0;

  constructor(config: ServiceConfig, log: Logger) {
    this.#config = config;
    this.#log = log.child('pool');

    for (let i = 0; i < config.poolSize; i++) {
      this.#slots.push({
        id: i,
        // Slot N always gets proxy N, so a browser keeps its exit IP across
        // recycles and the fingerprint stays consistent with that IP.
        proxy:
          config.proxies.length > 0
            ? config.proxies[i % config.proxies.length]
            : null,
        state: 'starting',
        instance: null,
        pagesServed: 0,
        createdAt: Date.now(),
        activePages: 0,
        work: null,
        recycleRequested: false,
        recycleReason: null,
        generation: 0,
        launchFailures: 0,
      });
    }
  }

  get capacity(): number {
    return this.#config.poolSize * this.#config.pagesPerBrowser;
  }

  /**
   * Brings the pool up. Individual slot failures are tolerated as long as one
   * browser comes up: a partially healthy pool still serves traffic and the
   * supervisor retries the rest with backoff.
   */
  async start(): Promise<void> {
    this.#started = true;
    const results = await Promise.allSettled(
      this.#slots.map(slot => this.#ensureBrowser(slot)),
    );

    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length === this.#slots.length) {
      const reasons = failures
        .map(f =>
          f.status === 'rejected'
            ? f.reason instanceof Error
              ? f.reason.message
              : String(f.reason)
            : 'unknown',
        )
        .join('; ');
      throw new Error(
        `Failed to launch any Camoufox browser (${failures.length}/${this.#slots.length} failed): ${reasons}`,
      );
    }

    if (failures.length > 0) {
      this.#log.warn(
        `${failures.length}/${this.#slots.length} browsers failed to start; serving with the rest`,
      );
    }
  }

  /**
   * Read through a method so the `stopped` comparison is never narrowed away by
   * an earlier `slot.state = ...` assignment in the same function.
   */
  #isStopped(slot: Slot): boolean {
    return slot.state === 'stopped';
  }

  #backoffMs(slot: Slot): number {
    return Math.min(
      this.#config.relaunchBackoffMs * 2 ** Math.min(slot.launchFailures, 5),
      this.#config.relaunchMaxBackoffMs,
    );
  }

  /** Queues background work on a slot, collapsing repeated requests into one. */
  #schedule(slot: Slot, delayMs: number, run: () => Promise<void>): void {
    if (this.#closed || this.#isStopped(slot)) return;
    if (slot.work) return;
    slot.work = (async () => {
      try {
        if (delayMs > 0) await sleep(delayMs);
        await run();
      } catch (error) {
        this.#log.error('slot background work failed', {
          slot: slot.id,
          error,
        });
      } finally {
        slot.work = null;
      }
    })();
  }

  async #ensureBrowser(slot: Slot): Promise<void> {
    if (this.#closed || this.#isStopped(slot)) return;

    const proxy = slot.proxy;
    const generation = ++slot.generation;
    slot.state = 'starting';

    try {
      this.#log.info('launching camoufox', {
        slot: slot.id,
        proxy: redactProxy(proxy),
        geoip: this.#config.camoufox.geoip && proxy !== null,
      });

      const instance = await launchCamoufox({
        camoufox: this.#config.camoufox,
        proxy,
        allowLocalWebhooks: this.#config.allowLocalWebhooks,
        launchTimeoutMs: this.#config.launchTimeoutMs,
        log: this.#log.child(`slot${slot.id}`),
      });

      if (this.#closed || this.#isStopped(slot) || slot.generation !== generation) {
        // Shutdown or a recycle overtook this launch; don't leak the browser.
        await instance.close().catch(() => undefined);
        return;
      }

      slot.instance = instance;
      slot.state = 'ready';
      slot.createdAt = Date.now();
      slot.pagesServed = 0;
      slot.recycleRequested = false;
      slot.recycleReason = null;
      slot.launchFailures = 0;

      // A crash surfaces as a disconnect rather than as a throw on some
      // unrelated await, so it has to be observed explicitly.
      instance.browser.on('disconnected', () => {
        if (slot.generation !== generation) return;
        this.#log.warn('camoufox disconnected', { slot: slot.id });
        this.#markUnhealthy(slot, 'browser disconnected');
      });

      this.#log.info('camoufox ready', {
        slot: slot.id,
        fingerprint: instance.fingerprint,
      });
      this.#wake();
    } catch (error) {
      if (this.#closed || this.#isStopped(slot) || slot.generation !== generation) {
        return;
      }
      slot.instance = null;
      slot.state = 'starting';
      slot.launchFailures += 1;
      this.#log.error('camoufox launch failed', {
        slot: slot.id,
        failures: slot.launchFailures,
        error,
      });

      // Retry in the background: a transient failure (e.g. the proxy was
      // briefly unreachable during a GeoIP lookup) must not permanently shrink
      // the pool.
      const delay = this.#backoffMs(slot);
      this.#schedule(slot, delay, () => this.#ensureBrowser(slot));
      throw error;
    }
  }

  /** Tears a slot's browser down and brings up a replacement. */
  #markUnhealthy(slot: Slot, reason: string): void {
    if (this.#closed || this.#isStopped(slot)) return;
    slot.recycleRequested = true;
    slot.recycleReason = reason;

    if (slot.instance) {
      const instance = slot.instance;
      slot.instance = null;
      slot.state = 'starting';
      slot.launchFailures = 0;
      this.#totalRecycles += 1;
      this.#log.info('replacing browser', { slot: slot.id, reason });
      void instance.close().catch(() => undefined);
    }

    this.#schedule(slot, 0, () => this.#ensureBrowser(slot));
    this.#wake();
  }

  /**
   * Marks a slot for replacement. The teardown happens once its in-flight
   * pages drain, so an idle-timeout recycle never truncates a running scrape.
   */
  #requestRecycle(slot: Slot, reason: string): void {
    if (this.#closed || this.#isStopped(slot)) return;
    if (slot.recycleRequested) return;

    slot.recycleRequested = true;
    slot.recycleReason = reason;
    this.#log.info('scheduling browser recycle', {
      slot: slot.id,
      reason,
      pagesServed: slot.pagesServed,
      ageMs: Date.now() - slot.createdAt,
    });
    this.#maybeRecycle(slot);
  }

  #maybeRecycle(slot: Slot): void {
    if (!slot.recycleRequested) return;
    if (this.#closed || this.#isStopped(slot)) return;
    if (slot.activePages > 0) return;

    const instance = slot.instance;
    slot.instance = null;
    slot.state = 'starting';
    slot.recycleRequested = false;
    slot.recycleReason = null;
    this.#totalRecycles += 1;
    this.#log.info('recycling browser', {
      slot: slot.id,
      reason: 'drained',
      fingerprint: instance?.fingerprint,
    });

    this.#schedule(slot, 0, async () => {
      if (instance) await instance.close().catch(() => undefined);
      if (this.#closed || this.#isStopped(slot)) return;
      await this.#ensureBrowser(slot);
    });
    this.#wake();
  }

  #recycleDue(slot: Slot): boolean {
    if (!slot.instance) return false;
    if (slot.pagesServed >= this.#config.recyclePages) return true;
    return Date.now() - slot.createdAt >= this.#config.maxLifetimeMs;
  }

  #wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) waiter();
  }

  #waitForChange(timeoutMs: number): Promise<void> {
    return new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.#waiters.add(finish);
    });
  }

  /**
   * Acquires a browser with a fresh context and page.
   *
   * @param timeoutMs how long to wait for capacity before failing.
   * @param ignoreHTTPSErrors per-request TLS relaxation, applied by the caller
   *   on the context before navigation.
   */
  async acquire(
    options: {
      timeoutMs?: number;
      /** Per-request TLS relaxation; only settable at context creation. */
      ignoreHTTPSErrors?: boolean;
    } = {},
  ): Promise<PageLease> {
    if (this.#closed) throw new Error('Browser pool is shutting down');
    if (!this.#started) throw new Error('Browser pool has not been started');

    const timeoutMs = options.timeoutMs ?? this.#config.acquireTimeoutMs;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (this.#closed) throw new Error('Browser pool is shutting down');

      const slot = this.#pickSlot();
      if (slot) {
        return this.#createLease(slot, options.ignoreHTTPSErrors === true);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for a free Camoufox browser`,
        );
      }
      await this.#waitForChange(Math.min(remaining, 250));
    }
  }

  #pickSlot(): Slot | null {
    const candidates = this.#slots.filter(
      slot =>
        slot.state === 'ready' &&
        slot.instance !== null &&
        !slot.recycleRequested &&
        slot.activePages < this.#config.pagesPerBrowser,
    );
    if (candidates.length === 0) return null;

    // Prefer the least-used slot so fingerprints rotate evenly and no single
    // instance absorbs the whole load.
    candidates.sort((a, b) => a.pagesServed - b.pagesServed || a.id - b.id);
    return candidates[0] ?? null;
  }

  async #createLease(slot: Slot, ignoreHTTPSErrors: boolean): Promise<PageLease> {
    const instance = slot.instance;
    if (!instance) {
      this.#markUnhealthy(slot, 'browser vanished before acquisition');
      throw new Error('Browser slot lost its browser before acquisition');
    }

    let context: BrowserContext;
    let page: Page;
    try {
      context = await instance.browser.newContext({
        // Camoufox pins its own window geometry. Letting Playwright apply its
        // 1280x720 default would desync the spoofed screen size from the real
        // window; an explicit viewport from config still wins.
        viewport: this.#config.camoufox.viewport,
        ignoreHTTPSErrors,
        javaScriptEnabled: true,
      });
      page = await context.newPage();
    } catch (error) {
      // A context that cannot be created almost always means the browser died
      // or lost its connection; replacing it beats failing every future scrape.
      this.#markUnhealthy(slot, 'context creation failed');
      throw error;
    }

    slot.pagesServed += 1;
    slot.activePages += 1;
    this.#totalScrapes += 1;

    let released = false;
    const lease: PageLease = {
      slotId: slot.id,
      fingerprint: instance.fingerprint,
      browser: instance.browser,
      context,
      page,
      markUnhealthy: reason => this.#markUnhealthy(slot, reason),
      release: async () => {
        if (released) return;
        released = true;
        slot.activePages = Math.max(0, slot.activePages - 1);
        try {
          await context.close();
        } catch (error) {
          // A closed browser makes context.close() throw; the slot is being
          // replaced anyway, so this is not actionable.
          this.#log.debug('error closing context', { error });
        }

        // Charge the page even when the scrape failed, so a target that errors
        // out still rotates the fingerprint instead of pinning one instance.
        if (this.#recycleDue(slot)) {
          this.#requestRecycle(slot, 'page or lifetime budget reached');
        }
        this.#maybeRecycle(slot);
        this.#wake();
      },
    };

    return lease;
  }

  stats(): PoolStats {
    const now = Date.now();
    const slots = this.#slots.map(slot => ({
      id: slot.id,
      state: slot.state,
      fingerprint: slot.instance?.fingerprint ?? null,
      proxy: redactProxy(slot.proxy),
      pagesServed: slot.pagesServed,
      activePages: slot.activePages,
      ageMs: slot.instance ? now - slot.createdAt : 0,
      recycleRequested: slot.recycleRequested,
    }));

    return {
      poolSize: this.#config.poolSize,
      ready: slots.filter(s => s.state === 'ready' && s.fingerprint).length,
      starting: slots.filter(s => s.state === 'starting').length,
      activePages: slots.reduce((sum, s) => sum + s.activePages, 0),
      capacity: this.capacity,
      totalScrapes: this.#totalScrapes,
      totalRecycles: this.#totalRecycles,
      slots,
    };
  }

  hasHealthyBrowser(): boolean {
    return this.#slots.some(
      slot => slot.state === 'ready' && slot.instance !== null,
    );
  }

  /** Tears down every browser. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();

    await Promise.allSettled(
      this.#slots.map(async slot => {
        const instance = slot.instance;
        slot.instance = null;
        slot.state = 'stopped';
        slot.work = null;
        if (instance) await instance.close().catch(() => undefined);
      }),
    );
  }
}