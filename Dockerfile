ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.60.0-noble

FROM ${PLAYWRIGHT_IMAGE} AS base

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

FROM base AS build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS smoke-test

COPY eslint.config.js playwright.config.ts vitest.config.ts ./
COPY config.example.yml ./
COPY test ./test
RUN npm run lint \
    && npm run build \
    && npm test \
    && npm run test:e2e

FROM base AS production-dependencies

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

FROM base AS production

ENV NODE_ENV=production
ENV CONFIG_PATH=/app/config.yml
ENV HOME=/tmp
ENV XDG_CONFIG_HOME=/tmp/.config
ENV XDG_CACHE_HOME=/tmp/.cache

COPY --chown=pwuser:pwuser --from=production-dependencies /app/package.json ./package.json
COPY --chown=pwuser:pwuser --from=production-dependencies /app/package-lock.json ./package-lock.json
COPY --chown=pwuser:pwuser --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=pwuser:pwuser --from=build /app/dist ./dist
COPY --chown=pwuser:pwuser config.example.yml ./config.example.yml

USER pwuser

CMD ["node", "dist/index.js"]
