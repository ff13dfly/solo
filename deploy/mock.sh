#!/bin/bash
#
# mock.sh — launch a DEV mock webhook listener for ingress simulation testing.
#
# It starts deploy/mock/listener.js, which simulates an external listener:
# you POST arbitrary JSON to it, it wraps as { request_id, data } and forwards
# to ingress /ingest with an API key. Exercises the full chain:
#   curl → mock listener → ingress → EVENT:WEBHOOK:* → matcher/agent
#
# NOT part of the SOLO bundle (deploy/mock/ is dev-only tooling).
#
# Prerequisite: an ingress source exists and you have its API key. Create one via
#   Portal → Ingress  (or RPC ingress.source.create), copy the one-time API key.
#
# Usage:
#   INGRESS_API_KEY=ingk_xxx bash deploy/mock.sh
#   INGRESS_API_KEY=ingk_xxx MOCK_PORT=8090 SOURCE_NAME=github bash deploy/mock.sh
#   bash deploy/mock.sh ingk_xxx          # key as first arg also works
#
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

# Allow API key as first positional arg.
if [ -n "$1" ] && [ -z "$INGRESS_API_KEY" ]; then
    export INGRESS_API_KEY="$1"
fi

if [ -z "$INGRESS_API_KEY" ]; then
    printf "${RED}✗ INGRESS_API_KEY not set.${NC}\n"
    printf "  Create a source first (Portal → Ingress, or RPC ingress.source.create),\n"
    printf "  copy the one-time API key, then:\n\n"
    printf "    ${YELLOW}INGRESS_API_KEY=ingk_xxx bash deploy/mock.sh${NC}\n\n"
    exit 1
fi

export MOCK_PORT="${MOCK_PORT:-8090}"
# Default to the HTTPS front (dev SSL proxy 8800 → Router 8600), mirroring real
# usage. Needs the proxy up: `bash deploy/dev.sh --ssl`. To skip TLS, override:
#   ROUTER_URL=http://127.0.0.1:8600 bash deploy/mock.sh
export ROUTER_URL="${ROUTER_URL:-https://127.0.0.1:8800}"
export SOURCE_NAME="${SOURCE_NAME:-mock}"

printf "${GREEN}Starting mock listener${NC}\n"
printf "  port:        %s\n" "$MOCK_PORT"
printf "  router:      %s/jsonrpc (ingress.ingest)\n" "$ROUTER_URL"
printf "  source name: %s\n\n" "$SOURCE_NAME"
case "$ROUTER_URL" in
  https://*) printf "${YELLOW}  note: HTTPS 8800 requires the dev SSL proxy — start the stack with: bash deploy/dev.sh --ssl${NC}\n\n" ;;
esac

exec node "$SCRIPT_DIR/mock/listener.js"
