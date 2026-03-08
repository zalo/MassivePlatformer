#!/usr/bin/env bash
set -euo pipefail

# Deploy script for Massive Platformer
#
# Usage:
#   ./deploy.sh                   # Full deploy (container + worker)
#   ./deploy.sh --skip-container  # Worker + assets only

SKIP_CONTAINER=false
if [[ "${1:-}" == "--skip-container" ]]; then
    SKIP_CONTAINER=true
fi

echo "=== Deploying Massive Platformer ==="

if [[ "$SKIP_CONTAINER" == false ]]; then
    echo ""
    echo "--- Building container ---"

    # Bust Docker cache by injecting a unique build arg
    CACHE_BUST=$(date +%s)
    sed -i '/^ARG CACHE_BUST/d' container/Dockerfile
    sed -i "1a ARG CACHE_BUST=$CACHE_BUST" container/Dockerfile

    # Use wrangler's Dockerfile path so it handles registry auth automatically
    # (Docker registry tokens expire quickly — wrangler refreshes them on each deploy)
    sed -i 's|image = "registry.*"|image = "./container/Dockerfile"|' wrangler.toml

    echo ""
    echo "--- Bumping DO name for fresh container instance ---"
    CURRENT=$(grep -oP 'game-world-v\K\d+' src/worker.ts)
    NEXT=$((CURRENT + 1))
    sed -i "s/game-world-v${CURRENT}/game-world-v${NEXT}/" src/worker.ts
    echo "DO name: game-world-v${NEXT}"
fi

echo ""
echo "--- Deploying ---"
npx wrangler deploy

if [[ "$SKIP_CONTAINER" == false ]]; then
    # Clean up the cache bust arg
    sed -i '/^ARG CACHE_BUST/d' container/Dockerfile
fi

echo ""
echo "=== Deploy complete ==="
echo "Live at: https://massive-platformer.makeshifted.workers.dev"
echo ""
echo "Note: Container cold start takes ~10-20 seconds on first request."
