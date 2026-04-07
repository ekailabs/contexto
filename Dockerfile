# ---------- build base ----------
FROM node:20 AS build-base
WORKDIR /app

# Copy root manifests
COPY package.json pnpm-lock.yaml ./

# Copy per-workspace manifests
COPY packages/ui/dashboard/package.json packages/ui/dashboard/pnpm-lock.yaml* ./packages/ui/dashboard/
COPY packages/memory/package.json packages/memory/pnpm-lock.yaml ./packages/memory/
COPY packages/openrouter/package.json packages/openrouter/pnpm-lock.yaml ./packages/openrouter/

# Install all workspace deps from root
RUN corepack enable && pnpm install --frozen-lockfile --workspaces

# Copy the rest of the source
COPY . .

# ---------- dashboard build ----------
FROM build-base AS dashboard-build
WORKDIR /app/packages/ui/dashboard
ARG NEXT_PUBLIC_API_BASE_URL=__API_URL_PLACEHOLDER__
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
RUN pnpm run build

# ---------- memory build ----------
FROM build-base AS memory-build
WORKDIR /app/packages/memory
RUN pnpm run build

# ---------- openrouter build (depends on memory being built first) ----------
FROM build-base AS openrouter-build
WORKDIR /app/packages/memory
RUN pnpm run build
WORKDIR /app/packages/openrouter
RUN pnpm run build

# ---------- dashboard embedded build (static export for single-container) ----------
FROM build-base AS dashboard-embedded-build
WORKDIR /app/packages/ui/dashboard
ENV NEXT_BUILD_MODE=embedded
ENV NEXT_PUBLIC_EMBEDDED_MODE=true
RUN pnpm run build:embedded

# ---------- dashboard runtime ----------
FROM node:20-alpine AS dashboard-runtime
WORKDIR /app/packages/ui/dashboard
ENV NODE_ENV=production
COPY packages/ui/dashboard/package.json ./
RUN corepack enable && pnpm install --frozen-lockfile --omit=dev
COPY --from=dashboard-build /app/packages/ui/dashboard/.next ./.next
COPY --from=dashboard-build /app/packages/ui/dashboard/public ./public
COPY --from=dashboard-build /app/packages/ui/dashboard/next.config.mjs ./next.config.mjs
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]

# ---------- openrouter runtime (includes embedded memory) ----------
FROM node:20-alpine AS openrouter-runtime
WORKDIR /app
ENV NODE_ENV=production

# Memory package (workspace dependency of openrouter)
COPY packages/memory/package.json packages/memory/pnpm-lock.yaml ./packages/memory/
RUN cd packages/memory && pnpm install --frozen-lockfile --omit=dev
COPY --from=memory-build /app/packages/memory/dist ./packages/memory/dist

# OpenRouter — rewrite workspace ref to local file path before install
COPY packages/openrouter/package.json packages/openrouter/pnpm-lock.yaml ./packages/openrouter/
RUN cd packages/openrouter && \
    sed -i 's|"@ekai/memory": "\*"|"@ekai/memory": "file:../../memory"|' package.json && \
    pnpm install --frozen-lockfile --omit=dev
COPY --from=openrouter-build /app/packages/openrouter/dist ./packages/openrouter/dist

RUN mkdir -p /app/packages/memory/data
WORKDIR /app/packages/openrouter
EXPOSE 4010
CMD ["node", "dist/server.js"]

# ---------- fullstack runtime (dashboard + openrouter + memory) ----------
FROM node:20-alpine AS ekai-gateway-runtime
WORKDIR /app

RUN apk add --no-cache bash

# Dashboard
COPY packages/ui/dashboard/package.json ./packages/ui/dashboard/
RUN cd packages/ui/dashboard && pnpm install --frozen-lockfile --omit=dev
COPY --from=dashboard-build /app/packages/ui/dashboard/.next ./packages/ui/dashboard/.next
COPY --from=dashboard-build /app/packages/ui/dashboard/public ./packages/ui/dashboard/public
COPY --from=dashboard-build /app/packages/ui/dashboard/next.config.mjs ./packages/ui/dashboard/next.config.mjs

# Memory (workspace dependency of openrouter)
COPY packages/memory/package.json packages/memory/pnpm-lock.yaml ./packages/memory/
RUN cd packages/memory && pnpm install --frozen-lockfile --omit=dev
COPY --from=memory-build /app/packages/memory/dist ./packages/memory/dist
RUN mkdir -p /app/packages/memory/data

# OpenRouter — rewrite workspace ref to local file path before install
COPY packages/openrouter/package.json packages/openrouter/pnpm-lock.yaml ./packages/openrouter/
RUN cd packages/openrouter && \
    sed -i 's|"@ekai/memory": "\*"|"@ekai/memory": "file:../../memory"|' package.json && \
    pnpm install --frozen-lockfile --omit=dev
COPY --from=openrouter-build /app/packages/openrouter/dist ./packages/openrouter/dist

# Entrypoint
COPY scripts/start-docker-fullstack.sh /app/start-docker-fullstack.sh
RUN chmod +x /app/start-docker-fullstack.sh

ENV NODE_ENV=production

EXPOSE 3000 4010
VOLUME ["/app/packages/memory/data"]
CMD ["/app/start-docker-fullstack.sh"]
