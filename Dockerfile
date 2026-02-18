# ---------- build base ----------
FROM node:20 AS build-base
WORKDIR /app

# Copy root manifests
COPY package.json package-lock.json ./

# Copy per-workspace manifests (lock files may not exist for all)
COPY gateway/package.json gateway/package-lock.json* ./gateway/
COPY ui/dashboard/package.json ui/dashboard/package-lock.json* ./ui/dashboard/
COPY memory/package.json ./memory/
COPY integrations/openrouter/package.json ./integrations/openrouter/

# Install all workspace deps from root
RUN npm install --workspaces --include-workspace-root

# Copy the rest of the source
COPY . .

# ---------- gateway build ----------
FROM build-base AS gateway-build
WORKDIR /app/gateway
RUN npm run build

# ---------- dashboard build ----------
FROM build-base AS dashboard-build
WORKDIR /app/ui/dashboard
ARG NEXT_PUBLIC_API_BASE_URL=__API_URL_PLACEHOLDER__
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
RUN npm run build

# ---------- memory build ----------
FROM build-base AS memory-build
WORKDIR /app/memory
RUN npm run build

# ---------- openrouter build ----------
FROM build-base AS openrouter-build
WORKDIR /app/integrations/openrouter
RUN npm run build

# ---------- gateway runtime ----------
FROM node:20-alpine AS gateway-runtime
WORKDIR /app/gateway
ENV NODE_ENV=production
COPY gateway/package.json ./
RUN npm install --omit=dev
COPY --from=gateway-build /app/gateway/dist ./dist
COPY --from=gateway-build /app/model_catalog ./dist/model_catalog
RUN mkdir -p /app/gateway/data /app/gateway/logs
EXPOSE 3001
CMD ["node", "dist/gateway/src/index.js"]

# ---------- dashboard runtime ----------
FROM node:20-alpine AS dashboard-runtime
WORKDIR /app/ui/dashboard
ENV NODE_ENV=production
COPY ui/dashboard/package.json ./
RUN npm install --omit=dev
COPY --from=dashboard-build /app/ui/dashboard/.next ./.next
COPY --from=dashboard-build /app/ui/dashboard/public ./public
COPY --from=dashboard-build /app/ui/dashboard/next.config.mjs ./next.config.mjs
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]

# ---------- memory runtime ----------
FROM node:20-alpine AS memory-runtime
WORKDIR /app/memory
ENV NODE_ENV=production
COPY memory/package.json ./
RUN npm install --omit=dev
COPY --from=memory-build /app/memory/dist ./dist
RUN mkdir -p /app/memory/data
EXPOSE 4005
CMD ["node", "dist/server.js"]

# ---------- openrouter runtime ----------
FROM node:20-alpine AS openrouter-runtime
WORKDIR /app/integrations/openrouter
ENV NODE_ENV=production
COPY integrations/openrouter/package.json ./
RUN npm install --omit=dev
COPY --from=openrouter-build /app/integrations/openrouter/dist ./dist
EXPOSE 4010
CMD ["node", "dist/server.js"]

# ---------- fullstack runtime ----------
FROM node:20-alpine AS ekai-gateway-runtime
WORKDIR /app

RUN apk add --no-cache bash

# Gateway
COPY gateway/package.json ./gateway/
RUN cd gateway && npm install --omit=dev
COPY --from=gateway-build /app/gateway/dist ./gateway/dist
COPY --from=gateway-build /app/model_catalog ./model_catalog
RUN mkdir -p /app/gateway/data /app/gateway/logs

# Dashboard
COPY ui/dashboard/package.json ./ui/dashboard/
RUN cd ui/dashboard && npm install --omit=dev
COPY --from=dashboard-build /app/ui/dashboard/.next ./ui/dashboard/.next
COPY --from=dashboard-build /app/ui/dashboard/public ./ui/dashboard/public
COPY --from=dashboard-build /app/ui/dashboard/next.config.mjs ./ui/dashboard/next.config.mjs

# Memory
COPY memory/package.json ./memory/
RUN cd memory && npm install --omit=dev
COPY --from=memory-build /app/memory/dist ./memory/dist
RUN mkdir -p /app/memory/data

# OpenRouter
COPY integrations/openrouter/package.json ./integrations/openrouter/
RUN cd integrations/openrouter && npm install --omit=dev
COPY --from=openrouter-build /app/integrations/openrouter/dist ./integrations/openrouter/dist

# Entrypoint
COPY scripts/start-docker-fullstack.sh /app/start-docker-fullstack.sh
RUN chmod +x /app/start-docker-fullstack.sh

ENV NODE_ENV=production

EXPOSE 3001 3000 4005 4010
VOLUME ["/app/gateway/data", "/app/gateway/logs", "/app/memory/data"]
CMD ["/app/start-docker-fullstack.sh"]
