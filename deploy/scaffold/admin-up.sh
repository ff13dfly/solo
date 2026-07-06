#!/bin/bash
#
# admin-up.sh — Re-enable admin login after admin.self.lock.
#
# When the system administrator clicks "Lock & End Session" in portal/system,
# the administrator HTTP port closes and no one can log in. This script
# restarts the solo bundle so the administrator listener comes back online.
#
# Usage:
#   bash deploy/admin-up.sh
#
# What it does:
#   1. Kills any running solo.{version}.js process
#   2. Starts a fresh one via run.sh (passes through any flags)
#
# Notes:
#   - All sessions persist (they live in Redis), so other users are not affected.
#   - If you are running run.sh in another terminal, this script will replace it.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

VERSION_FILE="$ROOT_DIR/.solo-version"
[ ! -f "$VERSION_FILE" ] && { echo "✗ .solo-version not found"; exit 1; }
VERSION=$(tr -d '[:space:]' < "$VERSION_FILE")
BUNDLE="solo.${VERSION}.js"

# Stop any running solo bundle
PIDS=$(pgrep -f "$BUNDLE" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    echo "→ Stopping running solo bundle (pids: $PIDS)..."
    kill $PIDS 2>/dev/null || true
    for _ in 1 2 3 4 5; do
        sleep 1
        pgrep -f "$BUNDLE" >/dev/null 2>&1 || break
    done
    if pgrep -f "$BUNDLE" >/dev/null 2>&1; then
        echo "→ Force killing remaining processes..."
        pkill -9 -f "$BUNDLE" 2>/dev/null || true
        sleep 1
    fi
fi

echo "→ Starting solo via run.sh..."
exec bash "$SCRIPT_DIR/run.sh" "$@"
