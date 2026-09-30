/*
 * CamoCrawl — original end-to-end coverage for the Camoufox rendering backend.
 * Part of CamoCrawl (Firecrawl + Camoufox backend), licensed under the
 * GNU Affero General Public License v3.0 or later; see root LICENSE.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Do not remove this header or any upstream copyright/license notices.
 */
import { config } from "../../../config";
import {
  createTestIdUrl,
  concurrentIf,
  describeIf,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
  ALLOW_TEST_SUITE_WEBSITE,
  HAS_PLAYWRIGHT,
  HAS_PROXY,
} from "../lib";
import {
  idmux,
  Identity,
  scrape,
  scrapeRaw,
  scrapeTimeout,
} from "./lib";
import crypto from "crypto";

const stringbool = (value: string | undefined) => value === "true" || value === "1";

const playwrightAllowsLocalTargets = stringbool(
  process.env.ALLOW_LOCAL_WEBHOOKS,
);

/**
 * Win conditions for the Camoufox-backed rendering service.
 *
 * These only run where the rendering service is actually configured
 * (PLAYWRIGHT_MICROSERVICE_URL). On hosted Firecrawl the playwright engine is
 * not part of the fallback waterfall, so there is nothing to assert.
 *
 * Much of the existing coverage lives in scrape.test.ts; this file adds the
 * assertions specific to a *pooled* Camoufox backend — JS execution, sustained
 * concurrency, and stable results across fingerprint recycles.
 */
describeIf(TEST_SELF_HOST && HAS_PLAYWRIGHT)("Camoufox rendering", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({ name: "camoufox-rendering", concurrency: 50 });
  });

  const createSelfHostedLocalUrl = () => {
    const target = new URL(TEST_SUITE_WEBSITE);
    target.searchParams.set("testId", crypto.randomUUID());
    return target.toString();
  };

  const createDnsResolvedLocalUrl = () => {
    const target = new URL(createSelfHostedLocalUrl());
    target.hostname = "localtest.me";
    return target.toString();
  };

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "executes client-side JavaScript when waitFor is set",
    async () => {
      // The test site paints its content in after a delay, so this only
      // succeeds if a real browser ran the page's scripts.
      const response = await scrape(
        { url: createTestIdUrl(), waitFor: 2000 },
        identity,
      );

      expect(response.markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "returns rendered markup rather than an empty page",
    async () => {
      const response = await scrape(
        { url: createTestIdUrl(), formats: ["rawHtml"] },
        identity,
      );

      // A dead fingerprint, a broken viewport or a failed render all show up
      // as missing or nearly-empty HTML.
      expect(response.rawHtml).toBeDefined();
      expect(response.rawHtml!.length).toBeGreaterThan(200);
      expect(response.rawHtml).toContain("<");
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "serves concurrent scrapes from the browser pool",
    async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          scrape({ url: createTestIdUrl() }, identity),
        ),
      );

      for (const response of results) {
        expect(response.metadata.statusCode).toBe(200);
        expect(response.markdown).toContain("Firecrawl");
      }
    },
    scrapeTimeout * 2,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "stays healthy across repeated scrapes (fingerprint recycling)",
    async () => {
      // Enough sequential scrapes to cross the default per-browser page
      // budget, forcing at least one fingerprint recycle mid-test.
      for (let i = 0; i < 5; i++) {
        const response = await scrape({ url: createTestIdUrl() }, identity);
        expect(response.metadata.statusCode).toBe(200);
      }
    },
    scrapeTimeout * 3,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "still forwards cookies across redirects",
    async () => {
      // Gated to the rendering engine (where cookies are seeded into the
      // browser jar); a Cookie passed as an extra request header is dropped on
      // redirect hops.
      const response = await scrape(
        {
          url: "https://httpbin.org/redirect-to?url=https%3A%2F%2Fhttpbin.org%2Fcookies&status_code=302",
          headers: { Cookie: "fc_cookie_redirect_test=1" },
          formats: ["rawHtml"],
          waitFor: 1000,
        },
        identity,
      );

      expect(response.rawHtml).toContain("fc_cookie_redirect_test");
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "surfaces a non-200 target status without failing the scrape",
    async () => {
      const response = await scrape(
        { url: "https://httpbin.org/status/404" },
        identity,
      );

      expect(response.metadata.statusCode).toBe(404);
    },
    scrapeTimeout,
  );

  concurrentIf(HAS_PROXY)(
    "sends traffic through the configured proxy",
    async () => {
      const response = await scrape(
        { url: "https://icanhazip.com", waitFor: 100 },
        identity,
      );

      expect(response.markdown?.trim()).toContain(
        config.PROXY_SERVER!.split("://").slice(-1)[0].split(":")[0],
      );
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_SELF_HOST && !playwrightAllowsLocalTargets)(
    "blocks local-network targets resolved via DNS",
    async () => {
      const raw = await scrapeRaw(
        { url: createDnsResolvedLocalUrl(), waitFor: 100 },
        identity,
      );

      expect(raw.statusCode).toBe(200);
      expect(raw.body.success).toBe(true);
      expect(raw.body.data?.metadata?.statusCode).toBe(403);
      expect(raw.body.data?.metadata?.error).toContain(
        "Blocked insecure target URL",
      );
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_SELF_HOST && playwrightAllowsLocalTargets)(
    "allows local-network targets when ALLOW_LOCAL_WEBHOOKS is enabled",
    async () => {
      const response = await scrape(
        { url: createSelfHostedLocalUrl(), waitFor: 100 },
        identity,
      );

      expect(response.markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );
});