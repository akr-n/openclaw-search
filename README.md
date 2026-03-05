# openclaw-search

Self-hosted private web search plugin for OpenClaw using SearXNG. Zero tracking, zero API costs, 100% private.

## Requirements

- **OpenClaw** >= 2026.2.0 installed and running
- **Docker** (for SearXNG)

## Quick Setup

```bash
git clone https://github.com/akr-n/openclaw-search.git
cd openclaw-search
./deploy.sh
```

The deploy script handles everything: SearXNG container, JSON API config, plugin installation, and gateway restart.

## Manual Installation

### 1. Start SearXNG

```bash
docker run -d \
  --name searxng \
  --restart=always \
  -p 127.0.0.1:8888:8080 \
  searxng/searxng:latest

# Wait for initialization
sleep 15

# Enable JSON API (required)
docker exec searxng sed -i '/formats:/a\    - json' /etc/searxng/settings.yml
docker restart searxng
```

Verify it works:
```bash
curl "http://localhost:8888/search?q=test&format=json" | jq '.results | length'
```

### 2. Install the Plugin

```bash
# From GitHub
openclaw plugins install https://github.com/akr-n/openclaw-search.git

# Or from local clone
openclaw plugins install ~/openclaw-search
```

### 3. Allow the Plugin

OpenClaw 2026.2.19+ requires plugins to be explicitly allowed. Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-search"]
  }
}
```

Or via CLI:
```bash
openclaw plugins enable openclaw-search
```

### 4. Restart the Gateway

```bash
openclaw gateway restart
```

### 5. Verify

```bash
openclaw plugins list | grep openclaw-search
openclaw plugins info openclaw-search
```

## Configuration

The plugin works out of the box with defaults. To customize, edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-search"],
    "entries": {
      "openclaw-search": {
        "enabled": true,
        "config": {
          "baseUrl": "http://localhost:8888",
          "maxResults": 10,
          "language": "en",
          "safesearch": 0,
          "timeout": 15
        }
      }
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | string | `http://localhost:8888` | Your SearXNG instance URL |
| `maxResults` | number | `10` | Results per search (1-100) |
| `language` | string | `en` | ISO 639-1 language code (en, zh, de, etc.) |
| `safesearch` | number | `0` | 0=off, 1=moderate, 2=strict |
| `timeout` | number | `15` | Request timeout in seconds (5-60) |

## Search Tools (6)

Once installed, OpenClaw automatically picks the right tool based on your query:

| Tool | Description | Example |
|------|-------------|---------|
| `search` | General web search | "Search for quantum computing" |
| `search_news` | News articles | "Find recent AI news" |
| `search_images` | Image search | "Show me sunset pictures" |
| `search_videos` | Video search (YouTube, Vimeo, etc.) | "Find Python tutorial videos" |
| `search_repos` | Code repositories (auto-detects GitHub/GitLab/Bitbucket) | "Search for React repositories" |
| `quick_answer` | Direct factual answers | "What is quantum computing?" |

## Troubleshooting

**Plugin not loading:**
```bash
# Check status
openclaw plugins list | grep openclaw-search

# Reinstall
openclaw plugins uninstall openclaw-search
openclaw plugins install ~/openclaw-search
openclaw gateway restart
```

**Search returns errors:**
```bash
# Check SearXNG is running
curl http://localhost:8888

# Check JSON API works
curl "http://localhost:8888/search?q=test&format=json" | jq

# Check plugin config
openclaw config get plugins.entries.openclaw-search.config.baseUrl
```

**Connection timeout:** Increase `timeout` in config or check that SearXNG is accessible at the configured `baseUrl`.

## Uninstall

```bash
openclaw plugins uninstall openclaw-search
openclaw gateway restart

# Optionally remove SearXNG
docker stop searxng && docker rm searxng
```

## License

MIT
