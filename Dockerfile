FROM node:22-bookworm AS build

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# package-lock.json must be copied alongside package.json, before install --
# otherwise npm resolves every ^-range fresh against the registry's current
# state instead of the exact graph CI tested, and the image isn't
# reproducible. npm ci (unlike npm install) also enforces that the lockfile
# is honoured exactly rather than silently rewritten.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
RUN npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Chromium's shared-library dependencies are a genuine runtime need (the
# app launches it via Playwright), so they're reinstalled here rather than
# dropped -- but nothing else from the build stage carries over: no
# TypeScript sources, no devDependencies, no build toolchain or npm cache.
# The browser binary itself is copied from the build stage rather than
# downloaded again, and install-deps runs against that already-local copy
# of Playwright instead of fetching it fresh from the registry.
COPY --from=build /ms-playwright /ms-playwright
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
RUN npx playwright install-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && chown -R node:node /app

USER node

CMD ["npm", "run", "start:control"]
