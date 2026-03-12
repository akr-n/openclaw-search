# OpenClaw Search Engine

Private, self-hosted web search for OpenClaw. Aggregates results from Google, Brave, and Startpage via SearXNG, with Google News powered by SerpAPI.

## Architecture

```
OpenClaw Agent
    |
    |-- search, search_images, search_videos, search_repos, quick_answer
    |       |
    |       v
    |   openclaw-search plugin
    |       |
    |       |-- [parallel request 1] SearXNG --> Brave (direct)
    |       |                              \--> Startpage (direct)
    |       |                              \--> Google (via IPRoyal proxy)
    |       |
    |       |-- [parallel request 2] SearXNG --> Google only (via IPRoyal, with retry)
    |       |
    |       \-- merge: Google results first, then unique results from others
    |
    |-- search_news
            |
            v
        SerpAPI --> Google News API (250 free/month)
            |
            \-- fallback: SearXNG news engines if SerpAPI fails
```

## Components

| Component | Purpose | Location |
|-----------|---------|----------|
| **SearXNG** | Meta-search engine aggregator | Docker container on `localhost:8888` |
| **IPRoyal** | Rotating residential proxy for Google | `geo.iproyal.com:12321` |
| **SerpAPI** | Google News API | `serpapi.com` |
| **Tor** | Backup proxy (installed, not actively used) | `localhost:9050` |
| **openclaw-search plugin** | OpenClaw plugin with 6 search tools | `~/.openclaw/extensions/openclaw-search/` |

## Search Tools (6)

| Tool | Source | Typical Results | Use Case |
|------|--------|-----------------|----------|
| `search` | SearXNG (Google + Brave + Startpage) | 20-30 merged | General web search |
| `search_news` | SerpAPI Google News | up to 100 | Current events, breaking news |
| `search_images` | SearXNG (Google Images + Brave + others) | 100-450 | Image search |
| `search_videos` | SearXNG (Google Videos + YouTube + Brave) | 10-70 | Video search |
| `search_repos` | SearXNG (auto-adds site:github.com) | 10-20 | Code repository search |
| `quick_answer` | SearXNG | varies | Direct factual answers |

## Search Engines

| Engine | Proxy | Weight | Status |
|--------|-------|--------|--------|
| **Google** | IPRoyal (residential, US) | 3x (prioritized) | Active, ~100% with retry |
| **Brave** | None (direct) | 1x (default) | Active, always works |
| **Startpage** | None (direct) | 1x (default) | Active, always works |
| **DuckDuckGo** | Disabled | - | Disabled (persistent CAPTCHAs) |

## How the Search Plugin Works

1. **Parallel requests**: For every search, the plugin fires two SearXNG requests simultaneously:
   - One to all engines combined (fast, returns in ~0.6s)
   - One to Google only with retry (returns 8-10 results in ~1-2s)
2. **Google retry**: If Google returns 0 results (bad proxy IP), automatically retries once. IPRoyal rotates the IP on each request, so the retry gets a fresh residential IP.
3. **Merge**: Google results are placed first (highest quality), then unique results from Brave/Startpage are appended.
4. **Cache**: Results are cached for 5 minutes (LRU, 100 entries) to avoid duplicate requests.

## Performance (tested 2026-03-12)

| Metric | Value |
|--------|-------|
| Google success rate | 100% (10/10 with retry) |
| Avg Google results per query | 8.4 |
| Avg total merged results | 19.9 |
| Response time (combined) | 1-3 seconds |
| SerpAPI news results | up to 100 per query |

## Costs

| Service | Plan | Monthly Cost | Usage |
|---------|------|-------------|-------|
| **IPRoyal** | Residential, $1.75/GB, pay-as-you-go | ~$0.05 at 10 searches/day | Google proxy |
| **SerpAPI** | Free tier, 250 searches/month | $0 | Google News only |
| **SearXNG** | Self-hosted Docker | $0 | All search aggregation |
| **Tor** | Self-hosted | $0 | Backup (not actively used) |

## Configuration

### Plugin config (`~/.openclaw/openclaw.json`)

```json
{
  "plugins": {
    "entries": {
      "openclaw-search": {
        "enabled": true,
        "config": {
          "baseUrl": "http://localhost:8888",
          "serpApiKey": "<your-serpapi-key>",
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

### SearXNG config (`/opt/searxng/settings.yml`)

Key customizations from default:

```yaml
search:
  ban_time_on_fail: 1           # low ban time (rotating proxy = new IP each request)
  max_ban_time_on_fail: 30
  suspended_times:
    SearxEngineAccessDenied: 30  # quick recovery from blocks
    SearxEngineCaptcha: 60

outgoing:
  request_timeout: 10.0
  max_request_timeout: 15.0
  extra_proxy_timeout: 10
  networks:
    tor:                          # backup, not actively used
      proxies: socks5h://172.17.0.1:9050
      using_tor_proxy: true
    iproyal:                      # residential proxy for Google
      proxies: http://<user>:<pass>_country-us@geo.iproyal.com:12321

engines:
  - name: google
    network: iproyal              # route through residential proxy
    weight: 3                     # 3x score boost
  - name: brave
    # no network = direct (no proxy)
  - name: startpage
    # no network = direct (no proxy)
  - name: duckduckgo
    disabled: true                # persistent CAPTCHAs
```

## File Locations

| File | Purpose |
|------|---------|
| `~/.openclaw/extensions/openclaw-search/index.ts` | Plugin source code |
| `~/.openclaw/extensions/openclaw-search/openclaw.plugin.json` | Plugin manifest and config schema |
| `/opt/searxng/settings.yml` | SearXNG configuration (mounted into Docker) |
| `/etc/tor/torrc` | Tor config (listens on 127.0.0.1:9050 and 172.17.0.1:9050) |
| `/home/akr/openclaw-search/search.log` | Search request logs (JSON lines) |

## Services

| Service | Manager | Auto-start |
|---------|---------|------------|
| SearXNG | `sudo docker restart searxng` | Yes (`--restart=unless-stopped`) |
| Tor | `sudo systemctl restart tor` | Yes (enabled) |
| OpenClaw Gateway | `openclaw gateway restart` | Yes (systemd) |

## Troubleshooting

### Google returning 0 results
- **Cause**: IPRoyal assigned a flagged IP. The retry logic handles this automatically.
- **Check**: `curl -s "http://localhost:8888/search?q=test&format=json&engines=google" | jq '.results | length'`
- **If suspended**: SearXNG auto-recovers in 30 seconds. Or restart: `sudo docker restart searxng`

### SearXNG not responding
```bash
sudo docker ps | grep searxng          # check if running
sudo docker logs searxng --tail 20     # check errors
sudo docker restart searxng            # restart
```

### SerpAPI quota
- 250 free searches/month. Only used for `search_news`.
- Check usage at https://serpapi.com/dashboard
- If exhausted, `search_news` falls back to SearXNG news engines (Bing News, Yahoo News, Qwant News).

### IPRoyal proxy not working
```bash
# Test proxy directly
curl -s -x http://<user>:<pass>_country-us@geo.iproyal.com:12321 https://ipv4.icanhazip.com

# Test from inside SearXNG container
sudo docker exec searxng python3 -c "
import socket; s = socket.socket(); s.settimeout(5)
s.connect(('172.17.0.1', 9050)); print('Tor OK'); s.close()
"
```

### Restart everything
```bash
sudo systemctl restart tor
sudo docker restart searxng
sleep 15
openclaw gateway restart
```
