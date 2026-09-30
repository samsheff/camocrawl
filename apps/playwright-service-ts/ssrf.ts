/*
 * CamoCrawl — original rendering-service module.
 * Part of CamoCrawl (Firecrawl + Camoufox backend), licensed under the
 * GNU Affero General Public License v3.0 or later; see root LICENSE.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Do not remove this header or any upstream copyright/license notices.
 */
import { lookup } from 'dns/promises';
import IPAddr from 'ipaddr.js';
import { Server, RequestError } from 'proxy-chain';
import type { Logger } from './logger.js';

export class InsecureConnectionError extends Error {
  constructor(
    public readonly blockedUrl: string,
    reason: string,
  ) {
    super(`Blocked insecure target URL "${blockedUrl}": ${reason}`);
    this.name = 'InsecureConnectionError';
  }
}

/**
 * A hostname is considered unsafe when it resolves to anything that is not a
 * public unicast address. Resolution failures are treated as unsafe too: a name
 * we cannot resolve is a name we cannot check.
 */
export const isInternalHost = async (hostname: string): Promise<boolean> => {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;

  let addresses: string[];
  if (IPAddr.isValid(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map(a => a.address);
    } catch {
      return true;
    }
  }

  return (
    addresses.length === 0 ||
    addresses.some(a => IPAddr.parse(a).range() !== 'unicast')
  );
};

export const assertSafeTargetUrl = async (
  urlString: string,
  allowLocalWebhooks: boolean,
): Promise<void> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new InsecureConnectionError(urlString, 'URL is invalid');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new InsecureConnectionError(
      urlString,
      `unsupported protocol "${parsedUrl.protocol}"`,
    );
  }

  if (
    !allowLocalWebhooks &&
    (await isInternalHost(parsedUrl.hostname))
  ) {
    throw new InsecureConnectionError(
      urlString,
      'resolves to a private/internal address',
    );
  }
};

export type SsrfGuard = {
  /** Local port the browser should use as its proxy. */
  port: number;
  close: () => Promise<void>;
};

/**
 * A local CONNECT proxy every browser is pointed at. It re-checks the resolved
 * destination on the connect path, which is the only place the browser's own
 * routing decisions have already been made, and forwards to the browser's
 * assigned upstream proxy when one is configured.
 *
 * The browser itself never talks to the upstream proxy directly: that keeps
 * per-instance proxy rotation possible (one guard per browser) and means a
 * compromised or misbehaving page cannot bypass the address check.
 */
export const startSsrfGuard = async (options: {
  allowLocalWebhooks: boolean;
  upstreamProxyUrl: string | undefined;
  log: Logger;
}): Promise<SsrfGuard> => {
  const { allowLocalWebhooks, upstreamProxyUrl, log } = options;

  const server = new Server({
    port: 0,
    host: '127.0.0.1',
    prepareRequestFunction: async ({ hostname, port }) => {
      if (!allowLocalWebhooks && (await isInternalHost(hostname))) {
        throw new RequestError(
          'Blocked: target resolves to a private/internal address',
          403,
        );
      }
      log.debug('proxying connection', { hostname, port });
      return { upstreamProxyUrl };
    },
  });

  await server.listen();

  return {
    port: server.port,
    close: () => server.close(true).then(() => undefined),
  };
};