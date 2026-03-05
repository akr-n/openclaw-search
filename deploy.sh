#!/bin/bash
# Deploy script for openclaw-search with SearXNG
# NOTE: This script requires sudo for Docker commands

set -e

echo "openclaw-search Deployment Script"
echo "================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Check if SearXNG is already running
if sudo docker ps | grep -q searxng; then
    echo -e "${GREEN}SearXNG is already running${NC}"
else
    echo "Step 1: Deploying SearXNG..."

    # Clean up old containers/volumes
    sudo docker stop searxng 2>/dev/null || true
    sudo docker rm searxng 2>/dev/null || true

    # Start SearXNG with default config
    sudo docker run -d \
      --name searxng \
      --restart=unless-stopped \
      --dns 74.51.192.1 \
      --dns 74.51.192.2 \
      -p 127.0.0.1:8888:8080 \
      -v /opt/searxng/settings.yml:/etc/searxng/settings.yml:ro \
      searxng/searxng:latest

    echo -e "${GREEN}SearXNG container started${NC}"
    echo "   Waiting for initialization (20 seconds)..."
    sleep 20

    # Enable JSON API (critical step!)
    echo "   Enabling JSON API..."
    sudo docker exec searxng sed -i '/^  formats:$/a\    - json' /etc/searxng/settings.yml

    echo "   Restarting SearXNG..."
    sudo docker restart searxng
    sleep 20

    echo -e "${GREEN}SearXNG configured with JSON API${NC}"
fi

# Verify SearXNG is working
echo ""
echo "Step 2: Verifying SearXNG..."
if curl -s --max-time 5 "http://localhost:8888" > /dev/null 2>&1; then
    echo -e "${GREEN}SearXNG is accessible at http://localhost:8888${NC}"

    # Test JSON API
    RESULT_COUNT=$(curl -s "http://localhost:8888/search?q=test&format=json" 2>/dev/null | jq -r '.results | length' 2>/dev/null || echo "0")
    if [ "$RESULT_COUNT" -gt 0 ]; then
        echo -e "${GREEN}JSON API is working ($RESULT_COUNT results)${NC}"
    else
        echo -e "${YELLOW}JSON API not ready, but continuing...${NC}"
    fi
else
    echo -e "${YELLOW}SearXNG may still be starting${NC}"
fi

# Install plugin
echo ""
echo "Step 3: Installing openclaw-search plugin..."
openclaw plugins install .

# Configure plugins.allow (OpenClaw 2026.2.19+)
[ -f ~/.openclaw/openclaw.json ] && command -v jq &>/dev/null && \
jq '.plugins.allow=(.plugins.allow//[]|.+["openclaw-search"]|unique)' ~/.openclaw/openclaw.json > /tmp/oc.tmp && mv /tmp/oc.tmp ~/.openclaw/openclaw.json

echo -e "${GREEN}Plugin installed${NC}"

# Restart gateway
echo ""
echo "Step 4: Restarting OpenClaw gateway..."
openclaw gateway restart

echo ""
echo "================================="
echo -e "${GREEN}Deployment complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Wait 10 seconds for gateway to fully restart"
echo "  2. Ask OpenClaw: 'Search for Python tutorials'"
echo ""
echo "URLs:"
echo "  SearXNG: http://localhost:8888"
echo "  Plugin: ~/.openclaw/extensions/openclaw-search"
echo ""
echo -e "${BLUE}Tip:${NC} SearXNG needs ~30 seconds for full initialization."
