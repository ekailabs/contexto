#!/bin/bash
set -euo pipefail

UI_PORT="${UI_PORT:-3000}"
OPENROUTER_PORT="${OPENROUTER_PORT:-4010}"

# Service toggles (all enabled by default)
ENABLE_DASHBOARD="${ENABLE_DASHBOARD:-true}"
ENABLE_OPENROUTER="${ENABLE_OPENROUTER:-true}"

PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup INT TERM

# Runtime API URL replacement for Next.js
if [ "$ENABLE_DASHBOARD" != "false" ] && [ "$ENABLE_DASHBOARD" != "0" ]; then
  API_URL="${NEXT_PUBLIC_API_BASE_URL:-http://localhost:${OPENROUTER_PORT}}"
  echo "Configuring API URL: $API_URL"
  cd /app/ui/dashboard
  if [ "$API_URL" != "__API_URL_PLACEHOLDER__" ]; then
    find .next -type f \( -name "*.js" -o -name "*.json" \) -exec sed -i "s|__API_URL_PLACEHOLDER__|$API_URL|g" {} + 2>/dev/null || true
  fi
fi

# Start services
echo ""
echo "  ekai-gateway (docker)"
echo ""

if [ "$ENABLE_DASHBOARD" != "false" ] && [ "$ENABLE_DASHBOARD" != "0" ]; then
  echo "  Starting dashboard on :${UI_PORT}"
  cd /app/ui/dashboard
  node_modules/.bin/next start -p "$UI_PORT" -H 0.0.0.0 &
  PIDS+=($!)
fi

if [ "$ENABLE_OPENROUTER" != "false" ] && [ "$ENABLE_OPENROUTER" != "0" ]; then
  echo "  Starting openrouter on :${OPENROUTER_PORT} (memory embedded)"
  cd /app/integrations/openrouter
  OPENROUTER_PORT="$OPENROUTER_PORT" MEMORY_DB_PATH="${MEMORY_DB_PATH:-/app/memory/data/memory.db}" node dist/server.js &
  PIDS+=($!)
fi

echo ""

if [ ${#PIDS[@]} -eq 0 ]; then
  echo "  No services enabled."
  exit 0
fi

# Wait for all children to exit (or indefinitely if restart=unless-stopped)
wait
