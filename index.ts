/**
 * openclaw-search - Self-hosted private web search for OpenClaw
 * Using SearXNG for privacy-focused search results
 *
 * @version 1.0.0
 * @license MIT
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { appendFileSync } from "node:fs";

const SEARCH_LOG = "/home/akr/openclaw-search/search.log";

function logSearch(entry: Record<string, any>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { appendFileSync(SEARCH_LOG, line + "\n"); } catch {}
}

interface PluginConfig {
  baseUrl?: string;
  maxResults?: number;
  language?: string;
  safesearch?: number;
  timeout?: number;
  serpApiKey?: string;
}

/**
 * Simple LRU cache with TTL for SearXNG responses
 */
class SearchCache {
  private cache = new Map<string, { data: any; timestamp: number }>();
  private maxEntries: number;
  private ttlMs: number;

  constructor(maxEntries = 100, ttlMs = 5 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.data;
  }

  set(key: string, data: any): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { data, timestamp: Date.now() });
  }
}

interface SearchToolConfig {
  name: string;
  description: string;
  category: string;
  formatResult: (result: any, idx: number) => string;
  additionalParams?: Record<string, any>;
}

interface SearchParams {
  query: string;
  count?: number;
  category: string;
  formatResult: (result: any, idx: number) => string;
}

export default function (api: OpenClawPluginApi) {
  const pluginConfig: PluginConfig = api.config.plugins?.entries?.['openclaw-search']?.config || {};
  const searchCache = new SearchCache(100, 5 * 60 * 1000);

  /**
   * Validate and sanitize search query
   */
  function validateQuery(query: string): string {
    if (!query || typeof query !== 'string') {
      throw new Error('Search query must be a non-empty string');
    }
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new Error('Search query cannot be empty');
    }
    if (trimmed.length > 500) {
      throw new Error('Search query too long (max 500 characters)');
    }
    return trimmed;
  }

  /**
   * Build search URL with all parameters
   */
  function buildSearchUrl(params: {
    baseUrl: string;
    query: string;
    category: string;
    language: string;
    safesearch: number;
  }): string {
    const { baseUrl, query, category, language, safesearch } = params;

    let url = `${baseUrl.replace(/\/$/, '')}/search?` +
      `q=${encodeURIComponent(query)}&` +
      `format=json&` +
      `language=${language}`;

    // Add category if not general
    if (category !== 'general') {
      url += `&categories=${category}`;
    }

    // Add safesearch for general/news searches
    if (category === 'general' || category === 'news') {
      url += `&safesearch=${safesearch}`;
    }

    return url;
  }

  /**
   * Format search results into readable text
   */
  function formatResults(
    results: any[],
    query: string,
    formatResult: (result: any, idx: number) => string,
    data: any
  ): string {
    let text = '';

    // Add direct answer if available (prioritize for quick answers)
    if (data.answers && data.answers.length > 0) {
      const answer = typeof data.answers[0] === 'string'
        ? data.answers[0]
        : JSON.stringify(data.answers[0]);
      text += `**Direct answer:**\n${answer}\n\n`;
    }

    // Add search results
    if (results.length === 0) {
      text += `No results found for "${query}".\n\n`;
      text += `Suggestions:\n`;
      text += `- Try different keywords\n`;
      text += `- Use more general terms\n`;
      text += `- Check spelling\n`;
      if (data.suggestions && data.suggestions.length > 0) {
        text += `\nRelated searches: ${data.suggestions.join(', ')}`;
      }
      return text;
    }

    text += `Found ${results.length} result${results.length !== 1 ? 's' : ''} for "${query}":\n\n`;

    results.forEach((result: any, idx: number) => {
      try {
        text += formatResult(result, idx);
      } catch (err) {
        // Skip malformed results
        console.error(`Failed to format result ${idx}:`, err);
      }
    });

    // Add suggestions if available
    if (data.suggestions && data.suggestions.length > 0) {
      text += `\n**Related searches:** ${data.suggestions.join(', ')}`;
    }

    return text;
  }

  /**
   * Fetch from a single SearXNG URL
   */
  async function fetchSearxng(url: string, timeout: number): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'OpenClaw/openclaw-search/1.0.0' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`SearXNG returned ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fetch Google results with retry — if first attempt returns 0 results,
   * retry once (IPRoyal rotates IP each request so second try gets a new IP).
   */
  async function fetchGoogleWithRetry(url: string, timeout: number, maxRetries = 2): Promise<any> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const data = await fetchSearxng(url, timeout);
        const count = (data.results || []).length;
        if (count > 0) return data;
        if (attempt < maxRetries) {
          logSearch({ event: 'google_retry', attempt, reason: '0 results, rotating IP' });
        }
      } catch (err) {
        if (attempt >= maxRetries) return { results: [] };
      }
    }
    return { results: [] };
  }

  /**
   * Generic search function — fires parallel requests to all engines + Google separately,
   * then merges results with Google prioritized.
   */
  async function performSearch(params: SearchParams) {
    const { query, count, category, formatResult } = params;

    try {
      const validatedQuery = validateQuery(query);
      const baseUrl = pluginConfig.baseUrl || 'http://localhost:8888';
      const maxResults = Math.min(Math.max(count || pluginConfig.maxResults || 10, 1), 100);
      const language = pluginConfig.language || 'en';
      const safesearch = pluginConfig.safesearch ?? 0;
      const timeout = (pluginConfig.timeout || 15) * 1000;

      const cacheKey = `${validatedQuery}::${category}`;
      const cachedData = searchCache.get(cacheKey);
      const t0 = Date.now();

      if (cachedData) {
        logSearch({ query: validatedQuery, category, cache: "hit", ms: Date.now() - t0, results: (cachedData.results || []).length });
        const results = (cachedData.results || []).slice(0, maxResults);
        const text = formatResults(results, validatedQuery, formatResult, cachedData);
        return { content: [{ type: 'text', text }] };
      }

      // Build URLs: combined (all engines) + Google-only
      const combinedUrl = buildSearchUrl({ baseUrl, query: validatedQuery, category, language, safesearch });
      const googleEngines = category === 'images' ? 'google+images'
        : category === 'videos' ? 'google+videos'
        : category === 'news' ? 'google+news'
        : 'google';
      const googleUrl = combinedUrl + `&engines=${encodeURIComponent(googleEngines)}`;

      // Fire both in parallel — don't let one failure kill the other
      const [combinedResult, googleResult] = await Promise.allSettled([
        fetchSearxng(combinedUrl, timeout),
        fetchGoogleWithRetry(googleUrl, timeout)
      ]);

      const combinedData = combinedResult.status === 'fulfilled' ? combinedResult.value : { results: [] };
      const googleData = googleResult.status === 'fulfilled' ? googleResult.value : { results: [] };

      // Merge: start with Google results, then add non-duplicate combined results
      const seenUrls = new Set<string>();
      const merged: any[] = [];

      // Google results first (weighted higher)
      for (const r of (googleData.results || [])) {
        if (r.url && !seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          merged.push(r);
        }
      }

      // Then combined results (Brave, Startpage, etc.)
      for (const r of (combinedData.results || [])) {
        if (r.url && !seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          merged.push(r);
        }
      }

      const data = { ...combinedData, results: merged, answers: combinedData.answers || googleData.answers };
      searchCache.set(cacheKey, data);

      const elapsed = Date.now() - t0;
      const engines = [...new Set(merged.map((r: any) => r.engine))];
      logSearch({ query: validatedQuery, category, cache: "miss", ms: elapsed, results: merged.length, engines });

      const results = merged.slice(0, maxResults);
      const text = formatResults(results, validatedQuery, formatResult, data);

      return { content: [{ type: 'text', text }] };

    } catch (err: any) {
      let errorMsg = 'Search failed: ';
      if (err.name === 'AbortError') {
        errorMsg += `Request timeout after ${pluginConfig.timeout || 15} seconds`;
      } else if (err.message.includes('fetch')) {
        errorMsg += `Cannot connect to SearXNG at ${pluginConfig.baseUrl || 'http://localhost:8888'}. Make sure SearXNG is running.`;
      } else {
        errorMsg += err.message;
      }
      logSearch({ query, category, cache: "error", error: errorMsg });
      return { content: [{ type: 'text', text: errorMsg }], isError: true };
    }
  }

  /**
   * Create a search tool from configuration
   */
  function createSearchTool(config: SearchToolConfig) {
    const baseParams: any = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (max 500 characters)'
        },
        count: {
          type: 'number',
          description: 'Number of results (1-100)',
          default: 10,
          minimum: 1,
          maximum: 100
        }
      },
      required: ['query']
    };

    // Merge additional parameters if provided
    if (config.additionalParams) {
      Object.assign(baseParams.properties, config.additionalParams);
    }

    return {
      name: config.name,
      description: config.description,
      parameters: baseParams,
      async execute(_id: string, params: any) {
        // Auto-enhance query for search_repos
        let query = params.query;
        if (config.name === 'search_repos' && !query.includes('site:')) {
          const lowerQuery = query.toLowerCase();
          if (lowerQuery.includes('gitlab')) {
            query = `${query} site:gitlab.com`;
          } else if (lowerQuery.includes('bitbucket')) {
            query = `${query} site:bitbucket.org`;
          } else {
            query = `${query} site:github.com`;
          }
        }

        return performSearch({
          query: query,
          count: params.count,
          category: config.category,
          formatResult: config.formatResult
        });
      }
    };
  }

  /**
   * SerpAPI Google News search (uses paid API sparingly)
   */
  const SERPAPI_KEY = pluginConfig.serpApiKey || '2e12e1e647e88db6946676de7c8d097c206d134fd7177f23104af6489f096836';

  async function performSerpApiNews(query: string, count?: number) {
    const validatedQuery = validateQuery(query);
    const maxResults = Math.min(count || pluginConfig.maxResults || 10, 20);
    const cacheKey = `serpapi_news::${validatedQuery}`;
    const cached = searchCache.get(cacheKey);
    const t0 = Date.now();

    if (cached) {
      logSearch({ query: validatedQuery, category: 'serpapi_news', cache: 'hit', ms: Date.now() - t0, results: cached.length });
      const text = formatSerpApiNews(cached, validatedQuery, maxResults);
      return { content: [{ type: 'text', text }] };
    }

    try {
      const url = `https://serpapi.com/search?engine=google_news&q=${encodeURIComponent(validatedQuery)}&api_key=${SERPAPI_KEY}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`SerpAPI returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const results = data.news_results || [];
      searchCache.set(cacheKey, results);

      const elapsed = Date.now() - t0;
      logSearch({ query: validatedQuery, category: 'serpapi_news', cache: 'miss', ms: elapsed, results: results.length });

      const text = formatSerpApiNews(results, validatedQuery, maxResults);
      return { content: [{ type: 'text', text }] };

    } catch (err: any) {
      logSearch({ query: validatedQuery, category: 'serpapi_news', cache: 'error', error: err.message });
      // Fallback to SearXNG news
      return performSearch({
        query: validatedQuery,
        count: maxResults,
        category: 'news',
        formatResult: (result: any, idx: number) => {
          let text = `${idx + 1}. **${result.title}**\n`;
          text += `   ${result.url}\n`;
          if (result.publishedDate) {
            try { text += `   ${new Date(result.publishedDate).toLocaleDateString()}\n`; } catch {}
          }
          if (result.content) text += `   ${result.content.substring(0, 200)}...\n`;
          return text + '\n';
        }
      });
    }
  }

  function formatSerpApiNews(results: any[], query: string, max: number): string {
    if (!results || results.length === 0) {
      return `No news results found for "${query}".`;
    }
    const sliced = results.slice(0, max);
    let text = `Found ${sliced.length} news result${sliced.length !== 1 ? 's' : ''} for "${query}" (via Google News):\n\n`;
    sliced.forEach((r: any, idx: number) => {
      text += `${idx + 1}. **${r.title}**\n`;
      if (r.link) text += `   ${r.link}\n`;
      if (r.source?.name) text += `   Source: ${r.source.name}`;
      if (r.date) text += ` | ${r.date}`;
      text += '\n';
      if (r.snippet) text += `   ${r.snippet.substring(0, 200)}\n`;
      // Include sub-stories if present
      if (r.stories && r.stories.length > 0) {
        r.stories.slice(0, 2).forEach((s: any) => {
          text += `   → ${s.title} (${s.source?.name || ''})\n`;
        });
      }
      text += '\n';
    });
    return text;
  }

  /**
   * Search tool configurations
   */
  const searchTools: SearchToolConfig[] = [
    {
      name: 'search',
      description: 'Search the web using your self-hosted SearXNG instance. Returns web results from multiple search engines.',
      category: 'general',
      formatResult: (result, idx) => {
        let text = `${idx + 1}. **${result.title}**\n`;
        text += `   ${result.url}\n`;
        if (result.content) {
          const snippet = result.content.substring(0, 200);
          text += `   ${snippet}${result.content.length > 200 ? '...' : ''}\n`;
        }
        return text + '\n';
      }
    },
    // search_news is registered separately via SerpAPI below
    {
      name: 'search_images',
      description: 'Search for images using your SearXNG instance. Returns image URLs and metadata.',
      category: 'images',
      formatResult: (result, idx) => {
        let text = `${idx + 1}. **${result.title || 'Untitled'}**\n`;
        text += `   Image: ${result.img_src || result.url}\n`;
        if (result.thumbnail_src) {
          text += `   Thumbnail: ${result.thumbnail_src}\n`;
        }
        if (result.url && result.url !== result.img_src) {
          text += `   Source: ${result.url}\n`;
        }
        return text + '\n';
      }
    },
    {
      name: 'search_videos',
      description: 'Search for videos from YouTube, Vimeo, and other platforms. Returns video URLs and metadata.',
      category: 'videos',
      formatResult: (result, idx) => {
        let text = `${idx + 1}. **${result.title}**\n`;
        text += `   ${result.url}\n`;
        if (result.publishedDate) {
          try {
            const date = new Date(result.publishedDate);
            text += `   ${date.toLocaleDateString()}\n`;
          } catch {}
        }
        if (result.content) {
          text += `   ${result.content.substring(0, 150)}...\n`;
        }
        return text + '\n';
      }
    },
    {
      name: 'search_repos',
      description: 'Search for code repositories. Automatically detects platform: GitHub (default), GitLab, or Bitbucket.',
      category: 'general',
      formatResult: (result, idx) => {
        let text = `${idx + 1}. **${result.title}**\n`;
        text += `   ${result.url}\n`;
        if (result.content) {
          text += `   ${result.content.substring(0, 200)}...\n`;
        }
        return text + '\n';
      }
    },
    {
      name: 'quick_answer',
      description: 'Get a direct answer to a factual question. Best for "what is", "who is", "when did" type questions.',
      category: 'general',
      formatResult: (result, idx) => {
        let text = `${idx + 1}. ${result.title}\n`;
        text += `   ${result.url}\n`;
        if (result.content) {
          text += `   ${result.content.substring(0, 300)}...\n`;
        }
        return text + '\n';
      }
    }
  ];

  // Register all SearXNG search tools
  searchTools.forEach(config => {
    api.registerTool(createSearchTool(config));
  });

  // Register SerpAPI Google News tool
  api.registerTool({
    name: 'search_news',
    description: 'Search for news articles using Google News (via SerpAPI). Best for current events and breaking news.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'News search query (max 500 characters)' },
        count: { type: 'number', description: 'Number of results (1-20)', default: 10, minimum: 1, maximum: 20 }
      },
      required: ['query']
    },
    async execute(_id: string, params: any) {
      return performSerpApiNews(params.query, params.count);
    }
  });
}
