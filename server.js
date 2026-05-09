// Anivex - Express Server for Render (and any Node.js host)
// Serves static Next.js export + /api/anime-servers endpoint
// Start: node server.js

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== ANIME SERVERS API ======
const ANITAKU_BASE = 'https://anitaku.to';
const ANIMENOSUB_BASE = 'https://animenosub.to';

const SERVER_NAMES = {
  'vibeplayer.site': 'Vibe HD',
  'otakuhg.site': 'StreamHG',
  'otakuvid.online': 'OtakuVid',
  'myvidplay.com': 'VidPlay',
  'playmogo.com': 'MogoPlay',
  'vidmoly.biz': 'VidMoly',
  'vidmoly.net': 'VidMoly',
  'bysesayeveum.com': 'StreamSB',
};

const EMBEDDABLE_HOSTS = new Set(['vibeplayer.site']);

function getServerName(url) {
  try {
    const hostname = new URL(url).hostname;
    if (SERVER_NAMES[hostname]) return SERVER_NAMES[hostname];
    for (const [key, name] of Object.entries(SERVER_NAMES)) {
      if (hostname.includes(key)) return name;
    }
    const cleaned = hostname.replace(/\.(site|online|com|net|org|to|cc|biz)/, '');
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  } catch { return 'Server'; }
}

function isEmbeddable(url) {
  try { return EMBEDDABLE_HOSTS.has(new URL(url).hostname); } catch { return false; }
}

async function searchAnitakuSlug(query) {
  try {
    const searchUrl = `${ANITAKU_BASE}/search.html?keyword=${encodeURIComponent(query)}`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const results = [];
    const linkRegex = /<a[^>]+href="\/category\/([^"]+)"[^>]*title="([^"]*)"/g;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      results.push({ slug: match[1], title: match[2] });
    }
    return results.length > 0 ? results[0].slug : null;
  } catch { return null; }
}

async function fetchAnitakuEpisode(slug, episode) {
  const url = `${ANITAKU_BASE}/${slug}-episode-${episode}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  if (!html || html.length < 500 || html.includes('Pages not found at Anitaku')) return null;

  const servers = { hsub: [], sub: [], dub: [] };
  const seenUrls = new Set();
  const videoRegex = /data-video="([^"]+)"[^>]*data-tab='tab_(\d+)'/g;
  let videoMatch;

  while ((videoMatch = videoRegex.exec(html)) !== null) {
    const videoUrl = videoMatch[1];
    if (seenUrls.has(videoUrl)) continue;
    seenUrls.add(videoUrl);
    const tabIndex = parseInt(videoMatch[2]);
    const serverData = { url: videoUrl, name: getServerName(videoUrl), embeddable: isEmbeddable(videoUrl) };
    if (tabIndex === 0 && !servers.hsub.some(s => s.url === videoUrl)) servers.hsub.push(serverData);
    else if (tabIndex === 1 && !servers.sub.some(s => s.url === videoUrl)) servers.sub.push(serverData);
    else if (tabIndex === 2 && !servers.dub.some(s => s.url === videoUrl)) servers.dub.push(serverData);
  }

  if (servers.hsub.length === 0 && servers.sub.length === 0 && servers.dub.length === 0) {
    const altRegex = /<iframe[^>]+src="([^"]+)"[^>]*>/g;
    let iframeMatch;
    while ((iframeMatch = altRegex.exec(html)) !== null) {
      let videoUrl = iframeMatch[1];
      if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
      if (seenUrls.has(videoUrl)) continue;
      if (!videoUrl.includes('vibeplayer') && !videoUrl.includes('otaku') &&
          !videoUrl.includes('vidplay') && !videoUrl.includes('vidmoly') &&
          !videoUrl.includes('playmogo')) continue;
      seenUrls.add(videoUrl);
      servers.hsub.push({ url: videoUrl, name: getServerName(videoUrl), embeddable: isEmbeddable(videoUrl) });
    }
  }

  const hasDub = html.includes('data-type="DUB"') || servers.dub.length > 0;
  if (servers.hsub.length > 0 || servers.sub.length > 0 || servers.dub.length > 0) {
    return { servers, hasDub, hasSub: true, source: 'anitaku' };
  }
  return null;
}

async function fetchAnimenosubEpisode(slug, episode) {
  const url = `${ANIMENOSUB_BASE}/${slug}-episode-${episode}/`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  if (!html || html.length < 500 || html.includes('Page Not Found')) return null;

  const servers = { hsub: [], sub: [], dub: [] };
  const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"[^>]*>/);
  const defaultUrl = iframeMatch ? (iframeMatch[1].startsWith('//') ? 'https:' + iframeMatch[1] : iframeMatch[1]) : null;

  if (defaultUrl) {
    servers.hsub.push({ url: defaultUrl, name: getServerName(defaultUrl), embeddable: isEmbeddable(defaultUrl) });
  }

  const selectStart = html.indexOf('class="mirror"');
  if (selectStart > 0) {
    const selectEnd = html.indexOf('</select>', selectStart);
    const selectHtml = html.substring(selectStart, selectEnd + 9);
    const options = selectHtml.match(/value="([^"]{10,})"/g) || [];
    for (const opt of options) {
      const b64 = opt.match(/value="([^"]+)"/)?.[1];
      if (!b64) continue;
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        const srcMatch = decoded.match(/src="([^"]+)"/);
        if (srcMatch) {
          const vidUrl = srcMatch[1].startsWith('//') ? 'https:' + srcMatch[1] : srcMatch[1];
          if (!servers.hsub.some(s => s.url === vidUrl)) {
            servers.hsub.push({ url: vidUrl, name: getServerName(vidUrl), embeddable: isEmbeddable(vidUrl) });
          }
        }
      } catch {}
    }
  }

  const isDub = html.includes('class="sb Dub"') || html.includes('-dub/');
  if (isDub) { servers.dub = [...servers.hsub]; servers.hsub = []; }

  if (servers.hsub.length > 0 || servers.sub.length > 0 || servers.dub.length > 0) {
    return { servers, hasDub: isDub || servers.dub.length > 0, hasSub: servers.hsub.length > 0 || servers.sub.length > 0, source: 'animenosub' };
  }
  return null;
}

async function fetchAnitakuDubEpisode(slug, episode) {
  const dubSlug = slug + '-dub';
  const url = `${ANITAKU_BASE}/${dubSlug}-episode-${episode}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  if (!html || html.length < 500 || html.includes('Pages not found at Anitaku')) return null;

  const servers = { hsub: [], sub: [], dub: [] };
  const videoRegex = /data-video="([^"]+)"[^>]*data-tab='tab_(\d+)'/g;
  let match;
  const seenUrls = new Set();
  while ((match = videoRegex.exec(html)) !== null) {
    const videoUrl = match[1];
    if (seenUrls.has(videoUrl)) continue;
    seenUrls.add(videoUrl);
    servers.dub.push({ url: videoUrl, name: getServerName(videoUrl), embeddable: isEmbeddable(videoUrl) });
  }
  if (servers.dub.length > 0) return { servers, hasDub: true, hasSub: false, source: 'anitaku-dub' };
  return null;
}

async function fetchAnimenosubDubEpisode(slug, episode) {
  const url = `${ANIMENOSUB_BASE}/${slug}-episode-${episode}-english-dub/`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  if (!html || html.length < 500 || html.includes('Page Not Found')) return null;

  const servers = { hsub: [], sub: [], dub: [] };
  const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"[^>]*>/);
  const defaultUrl = iframeMatch ? (iframeMatch[1].startsWith('//') ? 'https:' + iframeMatch[1] : iframeMatch[1]) : null;
  if (defaultUrl) servers.dub.push({ url: defaultUrl, name: getServerName(defaultUrl), embeddable: isEmbeddable(defaultUrl) });

  const selectStart = html.indexOf('class="mirror"');
  if (selectStart > 0) {
    const selectEnd = html.indexOf('</select>', selectStart);
    const selectHtml = html.substring(selectStart, selectEnd + 9);
    const options = selectHtml.match(/value="([^"]{10,})"/g) || [];
    for (const opt of options) {
      const b64 = opt.match(/value="([^"]+)"/)?.[1];
      if (!b64) continue;
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        const srcMatch = decoded.match(/src="([^"]+)"/);
        if (srcMatch) {
          const vidUrl = srcMatch[1].startsWith('//') ? 'https:' + srcMatch[1] : srcMatch[1];
          if (!servers.dub.some(s => s.url === vidUrl)) {
            servers.dub.push({ url: vidUrl, name: getServerName(vidUrl), embeddable: isEmbeddable(vidUrl) });
          }
        }
      } catch {}
    }
  }
  if (servers.dub.length > 0) return { servers, hasDub: true, hasSub: false, source: 'animenosub-dub' };
  return null;
}

// ====== API ROUTE ======
app.get('/api/anime-servers', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');

  const { slug, episode, search, dub } = req.query;

  // Search endpoint
  if (search) {
    const query = search || slug;
    if (!query) return res.status(400).json({ error: 'Missing search query' });
    const foundSlug = await searchAnitakuSlug(query);
    return res.status(200).json({ slug: foundSlug, query });
  }

  if (!slug || !episode) {
    return res.status(400).json({ error: 'Missing slug or episode parameter' });
  }

  try {
    const fetchDub = dub === 'true';
    const promises = [
      fetchAnitakuEpisode(slug, episode).catch(() => null),
      fetchAnimenosubEpisode(slug, episode).catch(() => null),
    ];
    if (fetchDub) {
      promises.push(fetchAnitakuDubEpisode(slug, episode).catch(() => null));
      promises.push(fetchAnimenosubDubEpisode(slug, episode).catch(() => null));
    }

    const results = await Promise.all(promises);
    const [anitakuResult, animenosubResult, anitakuDubResult, animenosubDubResult] = results;

    const merged = { slug, episode, servers: { hsub: [], sub: [], dub: [] }, hasDub: false, hasSub: false };

    for (const result of [anitakuResult, animenosubResult]) {
      if (result) {
        for (const type of ['hsub', 'sub', 'dub']) {
          for (const server of result.servers[type]) {
            if (!merged.servers[type].some(s => s.url === server.url)) merged.servers[type].push(server);
          }
        }
        merged.hasDub = merged.hasDub || result.hasDub;
        merged.hasSub = merged.hasSub || result.hasSub;
      }
    }

    for (const dubResult of [anitakuDubResult, animenosubDubResult]) {
      if (dubResult) {
        for (const server of dubResult.servers.dub) {
          if (!merged.servers.dub.some(s => s.url === server.url)) merged.servers.dub.push(server);
        }
        merged.hasDub = true;
      }
    }

    if (merged.servers.hsub.length === 0 && merged.servers.sub.length === 0 && merged.servers.dub.length === 0) {
      const searchQuery = slug.replace(/-/g, ' ');
      const foundSlug = await searchAnitakuSlug(searchQuery);
      if (foundSlug && foundSlug !== slug) {
        const retryResult = await fetchAnitakuEpisode(foundSlug, episode).catch(() => null);
        if (retryResult) {
          for (const type of ['hsub', 'sub', 'dub']) {
            for (const server of retryResult.servers[type]) {
              if (!merged.servers[type].some(s => s.url === server.url)) merged.servers[type].push(server);
            }
          }
          merged.hasDub = merged.hasDub || retryResult.hasDub;
          merged.hasSub = merged.hasSub || retryResult.hasSub;
          merged.resolvedSlug = foundSlug;
        }
      }
      if (merged.servers.hsub.length === 0 && merged.servers.sub.length === 0 && merged.servers.dub.length === 0) {
        return res.status(404).json({ error: 'No video servers found', slug, episode });
      }
    }

    for (const type of ['hsub', 'sub', 'dub']) {
      merged.servers[type].sort((a, b) => {
        if (a.embeddable && !b.embeddable) return -1;
        if (!a.embeddable && b.embeddable) return 1;
        return 0;
      });
    }

    return res.status(200).json(merged);
  } catch (err) {
    return res.status(500).json({ error: 'Server error', message: err.message });
  }
});

// OPTIONS preflight for CORS
app.options('/api/anime-servers', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

// ====== STATIC FILES + SPA FALLBACK ======
const outDir = path.join(__dirname, 'out');

// Serve static files from Next.js export
app.use(express.static(outDir, {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // Cache static assets longer
    if (filePath.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// SPA fallback: all non-API, non-file routes → index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(outDir, 'index.html'));
});

// ====== START SERVER ======
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Anivex server running on http://0.0.0.0:${PORT}`);
  console.log(`API endpoint: http://0.0.0.0:${PORT}/api/anime-servers`);
});
