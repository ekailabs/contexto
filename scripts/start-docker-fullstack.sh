#!/bin/bash
set -euo pipefail

GATEWAY_DIR="/app/gateway"
DASHBOARD_DIR="/app/ui/dashboard"

PORT="${PORT:-3001}"
UI_PORT="${UI_PORT:-3000}"

# Runtime API URL detection
if [ -n "${NEXT_PUBLIC_API_BASE_URL:-}" ]; then
  # If NEXT_PUBLIC_API_BASE_URL is set at runtime, use it
  API_URL="$NEXT_PUBLIC_API_BASE_URL"
else
  # Default for local development
  API_URL="http://localhost:${PORT}"
fi

echo "Configuring API URL: $API_URL"

# Replace placeholder in Next.js built files
cd "$DASHBOARD_DIR"
if [ "$API_URL" != "__API_URL_PLACEHOLDER__" ]; then
  echo "Replacing placeholder with $API_URL in Next.js build files..."
  find .next -type f \( -name "*.js" -o -name "*.json" \) -exec sed -i "s|__API_URL_PLACEHOLDER__|$API_URL|g" {} + 2>/dev/null || true
fi

cleanup() {
  if [ -n "${GW_PID:-}" ] && kill -0 "$GW_PID" 2>/dev/null; then
    kill "$GW_PID" 2>/dev/null || true
  fi
  if [ -n "${UI_PID:-}" ] && kill -0 "$UI_PID" 2>/dev/null; then
    kill "$UI_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM

cd "$GATEWAY_DIR"
node dist/gateway/src/index.js &
GW_PID=$!

cd "$DASHBOARD_DIR"
node_modules/.bin/next start -p "$UI_PORT" -H 0.0.0.0 &
UI_PID=$!

wait -n "$GW_PID" "$UI_PID"
