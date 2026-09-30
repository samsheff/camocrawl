FROM node:22-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

# Camoufox is a Firefox build, so it needs the GTK/X11/DBus runtime libraries
# that `playwright install-deps firefox` would pull in for Chromium too, plus
# `curl` for a build-time connectivity check.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl ca-certificates dumb-init fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Camoufox binaries live outside the per-user cache so they are readable by the
# unprivileged `node` user and survive a rebuild of the dependency layer.
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox

RUN pnpm run build

# Downloads the Camoufox build, the GeoLite2 city database used for GeoIP
# fingerprint alignment, and the bundled addons. Doing this at build time keeps
# the runtime free of network dependencies on first launch.
#
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD must stay unset here: camoufox-js treats it as
# "skip everything", which would silently produce an image with no browser.
RUN pnpm exec camoufox-js fetch \
  && test -x /opt/camoufox/camoufox-bin \
  && test -f /opt/camoufox/GeoLite2-City.mmdb \
  && chmod -R a+rX /opt/camoufox

RUN chown -R node:node /usr/src/app \
  && chmod -R a+rX /opt/camoufox

ARG PORT
ENV PORT=${PORT}

EXPOSE ${PORT}

USER node

# dumb-init reaps the orphaned Firefox child processes a crashed browser can
# leave behind; without a real init they accumulate until the container is
# restarted.
ENTRYPOINT ["dumb-init", "--"]

CMD [ "pnpm", "start" ]