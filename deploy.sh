#!/usr/bin/env bash
set -euo pipefail

# Deploy script for Massive Platformer
#
# Prerequisites:
#   - Docker running
#   - wrangler authenticated (wrangler login)
#   - CALLS_APP_ID and CALLS_APP_TOKEN set in wrangler.toml [vars]
#
# Usage:
#   ./deploy.sh          # Deploy everything
#   ./deploy.sh --skip-container  # Deploy only Worker + assets (no container rebuild)

SKIP_CONTAINER=false
if [[ "${1:-}" == "--skip-container" ]]; then
    SKIP_CONTAINER=true
fi

echo "=== Deploying Massive Platformer ==="

if [[ "$SKIP_CONTAINER" == false ]]; then
    echo ""
    echo "--- Building container image (no cache) ---"
    # Wrangler's Docker cache is aggressive and often serves stale images.
    # We build with --no-cache, push manually, then point wrangler at the tag.
    cd container
    TAG="deploy-$(date +%s)"
    docker build --no-cache -t "massive-platformer:$TAG" .

    echo ""
    echo "--- Pushing to Cloudflare registry ---"
    # Get account ID from wrangler
    ACCOUNT_ID=$(cd .. && npx wrangler whoami 2>/dev/null | grep -oP '[a-f0-9]{32}' | head -1)
    REGISTRY="registry.cloudflare.com/${ACCOUNT_ID}/massive-platformer-gamecontainer"

    # Wrangler handles registry auth during deploy, but for manual push we need to login
    # This reuses the credentials wrangler stores
    docker tag "massive-platformer:$TAG" "$REGISTRY:$TAG"
    docker push "$REGISTRY:$TAG"

    cd ..
    echo ""
    echo "--- Updating wrangler.toml with new image tag ---"
    sed -i "s|image = \".*\"|image = \"$REGISTRY:$TAG\"|" wrangler.toml

    echo ""
    echo "--- Bumping DO name for fresh container instance ---"
    # Container DOs are sticky to old images. Changing the name forces a fresh instance.
    CURRENT=$(grep -oP 'game-world-v\K\d+' src/worker.ts)
    NEXT=$((CURRENT + 1))
    sed -i "s/game-world-v${CURRENT}/game-world-v${NEXT}/" src/worker.ts
    echo "DO name: game-world-v${NEXT}"
fi

echo ""
echo "--- Deploying Worker + assets ---"
npx wrangler deploy

if [[ "$SKIP_CONTAINER" == false ]]; then
    # Restore wrangler.toml to use Dockerfile path for git cleanliness
    sed -i 's|image = "registry.*"|image = "./container/Dockerfile"|' wrangler.toml
fi

echo ""
echo "=== Deploy complete ==="
echo "Live at: https://massive-platformer.makeshifted.workers.dev"
