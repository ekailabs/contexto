# ---------- build base ----------
FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# Copy root manifests
COPY package.json pnpm-workspace.yaml ./

# Copy per-workspace manifests
COPY packages/memory/package.json packages/memory/package.json
COPY packages/ui/dashboard/package.json packages/ui/dashboard/package.json
COPY packages/integrations/openrouter/package.json packages/integrations/openrouter/package.json
COPY packages/integrations/openclaw/package.json packages/integrations/openclaw/package.json
COPY packages/api/package.json packages/api/package.json

# Install all workspace deps from root
RUN pnpm install --frozen-lockfile

# Copy the rest of the source
COPY . .

# ---------- dashboard build ----------
FROM base AS dashboard-build
WORKDIR /app/packages/ui/dashboard
ARG NEXT_PUBLIC_API_BASE_URL=__API_URL_PLACEHOLDER__
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
RUN pnpm run build

# ---------- memory build ----------
FROM base AS memory-build
WORKDIR /app/packages/memory
RUN pnpm run build

# ---------- openrouter build (depends on memory being built first) ----------
FROM base AS openrouter-build
WORKDIR /app/packages/memory
RUN pnpm run build
WORKDIR /app/packages/integrations/openrouter
RUN pnpm run build

# ---------- api build ----------
FROM base AS api-build
WORKDIR /app/packages/memory
RUN pnpm run build
WORKDIR /app/packages/api
RUN pnpm run build

# ---------- dashboard runtime ----------
FROM node:20-slim AS dashboard-runtime
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app/packages/ui/dashboard
ENV NODE_ENV=production
COPY packages/ui/dashboard/package.json ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=dashboard-build /app/packages/ui/dashboard/.next ./.next
COPY --from=dashboard-build /app/packages/ui/dashboard/public ./public
COPY --from=dashboard-build /app/packages/ui/dashboard/next.config.mjs ./next.config.mjs
EXPOSE 3000
CMD ["pnpm", "run", "start"]

# ---------- openrouter runtime (includes embedded memory) ----------
FROM node:20-slim AS openrouter-runtime
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
ENV NODE_ENV=production

# Memory package (workspace dependency of openrouter)
COPY packages/memory/package.json packages/memory/
RUN cd packages/memory && pnpm install --frozen-lockfile --prod
COPY --from=memory-build /app/packages/memory/dist packages/memory/dist

# OpenRouter
COPY packages/integrations/openrouter/package.json packages/integrations/openrouter/
RUN cd packages/integrations/openrouter && pnpm install --frozen-lockfile --prod
COPY --from=openrouter-build /app/packages/integrations/openrouter/dist packages/integrations/openrouter/dist

RUN mkdir -p /app/packages/memory/data
WORKDIR /app/packages/integrations/openrouter
EXPOSE 4010
CMD ["node", "dist/server.js"]

# ---------- api runtime ----------
FROM node:20-slim AS api-runtime
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
ENV NODE_ENV=production

# Memory package
COPY packages/memory/package.json packages/memory/
RUN cd packages/memory && pnpm install --frozen-lockfile --prod
COPY --from=memory-build /app/packages/memory/dist packages/memory/dist

# API Server
COPY packages/api/package.json packages/api/
RUN cd packages/api && pnpm install --frozen-lockfile --prod
COPY --from=api-build /app/packages/api/dist packages/api/dist

RUN mkdir -p /app/packages/api/data
WORKDIR /app/packages/api
EXPOSE 4010
CMD ["node", "dist/index.js"]

# ---------- fullstack runtime (dashboard + openrouter + memory) ----------
FROM node:20-slim AS ekai-gateway-runtime
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
ENV NODE_ENV=production

# Memory
COPY packages/memory/package.json packages/memory/
RUN cd packages/memory && pnpm install --frozen-lockfile --prod
COPY --from=memory-build /app/packages/memory/dist packages/memory/dist

# Dashboard
COPY packages/ui/dashboard/package.json packages/ui/dashboard/
RUN cd packages/ui/dashboard && pnpm install --frozen-lockfile --prod
COPY --from=dashboard-build /app/packages/ui/dashboard/.next packages/ui/dashboard/.next
COPY --from=dashboard-build /app/packages/ui/dashboard/public packages/ui/dashboard/public
COPY --from=dashboard-build /app/packages/ui/dashboard/next.config.mjs packages/ui/dashboard/next.config.mjs

# OpenRouter
COPY packages/integrations/openrouter/package.json packages/integrations/openrouter/
RUN cd packages/integrations/openrouter && pnpm install --frozen-lockfile --prod
COPY --from=openrouter-build /app/packages/integrations/openrouter/dist packages/integrations/openrouter/dist

RUN mkdir -p /app/packages/memory/data
EXPOSE 3000 4010

CMD ["sh", "-c", "echo 'Use docker-compose for full stack'"]