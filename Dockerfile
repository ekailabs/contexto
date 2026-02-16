# ---------- build base ----------
  FROM node:20 AS build-base
  WORKDIR /app
  
  # Copy manifests for cache-friendly installs
  COPY package.json package-lock.json ./
  COPY gateway/package.json gateway/package-lock.json ./gateway/
  COPY ui/dashboard/package.json ui/dashboard/package-lock.json ./ui/dashboard/
  
  # Install deps per project (no workspaces)
  RUN npm install
  RUN cd gateway && npm install
  RUN cd ui/dashboard && npm install
  
  # Copy the rest of the source
  COPY . .
  
  # ---------- gateway build ----------
  FROM build-base AS gateway-build
  WORKDIR /app/gateway
  RUN npm run build
  
# ---------- dashboard build ----------
FROM build-base AS dashboard-build
WORKDIR /app/ui/dashboard
# Accept build arg but default to a placeholder that can be replaced at runtime
ARG NEXT_PUBLIC_API_BASE_URL=__API_URL_PLACEHOLDER__
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
# For smaller runtime images, you could: RUN npm run build && npm prune --omit=dev
RUN npm run build
  
  # ---------- gateway runtime ----------
  FROM node:20-alpine AS gateway-runtime
  WORKDIR /app/gateway
  ENV NODE_ENV=production
  COPY gateway/package.json gateway/package-lock.json ./
  RUN npm install --omit=dev
  COPY --from=gateway-build /app/gateway/dist ./dist
  # Optional runtime dirs
  RUN mkdir -p /app/gateway/data /app/gateway/logs
  EXPOSE 3001
  CMD ["node", "dist/gateway/src/index.js"]
  
# ---------- dashboard runtime ----------
FROM node:20-alpine AS dashboard-runtime
WORKDIR /app/ui/dashboard
COPY ui/dashboard/package.json ui/dashboard/package-lock.json ./
RUN npm install --omit=dev
ENV NODE_ENV=production
  # Copy production build output
  COPY --from=dashboard-build /app/ui/dashboard/.next ./.next
  COPY --from=dashboard-build /app/ui/dashboard/public ./public
  # Copy config files
  COPY --from=dashboard-build /app/ui/dashboard/next.config.mjs ./next.config.mjs
  COPY --from=dashboard-build /app/ui/dashboard/postcss.config.mjs ./postcss.config.mjs
  EXPOSE 3000
  CMD ["node_modules/.bin/next", "start", "-p", "3000"]
  
# ---------- fullstack runtime ----------
FROM node:20-alpine AS ekai-gateway-runtime
WORKDIR /app

# bash is needed for wait -n in the entrypoint script
RUN apk add --no-cache bash

  # Gateway runtime bits
COPY gateway/package.json gateway/package-lock.json ./gateway/
RUN cd gateway && npm install --omit=dev
COPY --from=gateway-build /app/gateway/dist ./gateway/dist
RUN mkdir -p /app/gateway/data /app/gateway/logs

  # Dashboard runtime bits
COPY ui/dashboard/package.json ui/dashboard/package-lock.json ./ui/dashboard/
RUN cd ui/dashboard && npm install --omit=dev
  COPY --from=dashboard-build /app/ui/dashboard/.next ./ui/dashboard/.next
  COPY --from=dashboard-build /app/ui/dashboard/public ./ui/dashboard/public
  COPY --from=dashboard-build /app/ui/dashboard/next.config.mjs ./ui/dashboard/next.config.mjs
  COPY --from=dashboard-build /app/ui/dashboard/postcss.config.mjs ./ui/dashboard/postcss.config.mjs
  
# Entrypoint for running both services
COPY scripts/start-docker-fullstack.sh /app/start-docker-fullstack.sh
RUN chmod +x /app/start-docker-fullstack.sh

ENV NODE_ENV=production
  
EXPOSE 3001 3000
VOLUME ["/app/gateway/data", "/app/gateway/logs"]
CMD ["/app/start-docker-fullstack.sh"]
  
