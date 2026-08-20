// ===================================================
// সিক্রেট আইডি (প্রয়োজনে পরিবর্তন করুন)
// ===================================================
const EXPIRE_CODE = "554075"; 

// মূল M3U প্লেলিস্ট URL
const PLAYLIST_URL = "https://raw.githubusercontent.com/ahan443/FAST-IPTV/refs/heads/main/z.m3u";
// ===================================================

export default async function handler(req, res) {
  // CORS হেডার
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const host = req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const requestUrl = req.url || '';

  // ---------------------------------------------------------
  // ১. M3U প্লেলিস্ট রিকোয়েস্ট (যেমন: /api/proxy/playlist-expire=48436844.m3u)
  // ---------------------------------------------------------
  if (!req.query.url && (requestUrl.includes('.m3u') || requestUrl.includes('playlist-expire'))) {
    
    // সিকিউরিটি কোড যাচাইকরণ
    if (EXPIRE_CODE && !requestUrl.includes(EXPIRE_CODE)) {
      return res.status(403).json({ error: 'Access Denied: Invalid or Expired ID' });
    }

    try {
      const response = await fetch(PLAYLIST_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
      });

      if (!response.ok) {
        return res.status(response.status).json({ error: 'Failed to fetch playlist' });
      }

      const content = await response.text();
      const baseUrl = response.url; // Redirect সামলানোর জন্য

      // প্লেলিস্টের প্রতিটি চ্যানেলকে প্রক্সি লিংকে রূপান্তর
      const lines = content.split('\n');
      const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          try {
            const absUrl = new URL(trimmed, baseUrl).href;
            return `${protocol}://${host}/api/proxy?url=${encodeURIComponent(absUrl)}`;
          } catch (e) {
            return line;
          }
        }
        return line;
      });

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      return res.status(200).send(rewrittenLines.join('\n'));

    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // ---------------------------------------------------------
  // ২. নির্দিষ্ট চ্যানেল ও ভিডিও স্ট্রিম ফেচিং
  // ---------------------------------------------------------
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'No URL provided' });
  }

  try {
    const targetOrigin = new URL(targetUrl).origin;

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': targetOrigin + '/',
        'Origin': targetOrigin
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Stream failed (${response.status})` });
    }

    const contentType = response.headers.get('content-type') || '';
    const finalUrl = response.url; 

    // M3U8 বা সাব-প্লেলিস্ট চেক
    const isPlaylist = targetUrl.includes('.m3u') || 
                       contentType.includes('mpegurl') || 
                       contentType.includes('m3u') || 
                       contentType.includes('text/plain');

    if (isPlaylist) {
      const text = await response.text();

      if (text.trim().startsWith('#EXTM3U') || targetUrl.includes('.m3u8')) {
        const lines = text.split('\n');
        const rewrittenLines = lines.map(line => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          // #EXT-X-KEY (AES Encyption) ও #EXT-X-MEDIA ট্যাগের URI প্রক্সি রিরাইট
          if (trimmed.startsWith('#')) {
            if (trimmed.includes('URI=')) {
              return trimmed.replace(/URI=["']([^"']+)["']/g, (match, uri) => {
                try {
                  const abs = new URL(uri, finalUrl).href;
                  return `URI="${protocol}://${host}/api/proxy?url=${encodeURIComponent(abs)}"`;
                } catch (e) {
                  return match;
                }
              });
            }
            return line;
          }

          // ভিডিও সেগমেন্ট (.ts) বা সাব-প্লেলিস্ট রিরাইট
          try {
            const abs = new URL(trimmed, finalUrl).href;
            return `${protocol}://${host}/api/proxy?url=${encodeURIComponent(abs)}`;
          } catch (e) {
            return line;
          }
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        return res.status(200).send(rewrittenLines.join('\n'));
      }

      res.setHeader('Content-Type', contentType || 'text/plain');
      return res.status(200).send(text);
    }

    // TS/AAC/MP4 ভিডিও সেগমেন্ট প্লেয়ারে পাঠানো
    const arrayBuffer = await response.arrayBuffer();
    res.setHeader('Content-Type', contentType || 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(Buffer.from(arrayBuffer));

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}