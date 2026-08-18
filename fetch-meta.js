export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url, debug } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL' });

  let title = '', image = '', store = '', price = 0;

  // --- Strategy 1: fetch page HTML directly ---
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      redirect: 'follow',
    });
    const html = await r.text();

    if (debug) return res.json({ html: html.slice(0, 3000) });

    const getMeta = (...props) => {
      for (const prop of props) {
        let m = html.match(new RegExp('<meta[^>]*(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)["\']', 'i'))
             || html.match(new RegExp('<meta[^>]*content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i'));
        if (m) return m[1].trim();
      }
      return '';
    };

    const absUrl = (src) => {
      if (!src) return '';
      if (src.startsWith('//')) return 'https:' + src;
      if (src.startsWith('http')) return src;
      try { return new URL(src, url).href; } catch(e) { return src; }
    };

    // Title
    title = getMeta('og:title', 'twitter:title');
    if (!title) { const m = html.match(/<title[^>]*>([^<]+)<\/title>/i); title = m ? m[1] : ''; }
    title = title.replace(/&#?[a-z0-9]+;/gi, ' ').split(/\s*[|–—·•]\s*/)[0].trim();

    // Image
    image = absUrl(getMeta('og:image', 'og:image:url', 'twitter:image'));
    if (!image) {
      const m = html.match(/<[^>]+itemprop=["']image["'][^>]*(?:content|href)=["']([^"']+)["']/i);
      if (m) image = absUrl(m[1]);
    }

    // Store
    store = getMeta('og:site_name');

    // Price — JSON-LD
    for (const block of [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]) {
      if (price) break;
      try {
        const findP = (o) => {
          if (!o || typeof o !== 'object') return;
          if (['Product','Offer','AggregateOffer'].includes(o['@type'])) {
            const off = o.offers ? (Array.isArray(o.offers) ? o.offers[0] : o.offers) : o;
            const p = off.price !== undefined ? off.price : off.lowPrice;
            if (p != null) { price = parseFloat(String(p).replace(/[^0-9.]/g,'')); return; }
          }
          for (const v of Object.values(o)) findP(v);
        };
        [].concat(JSON.parse(block[1])).forEach(findP);
      } catch(e) {}
    }
    // Price — itemprop / meta
    if (!price) {
      const m = html.match(/<meta[^>]*itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)
             || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*itemprop=["']price["']/i)
             || html.match(/<[^>]+itemprop=["']price["'][^>]*content=["']([^"']+)["']/i);
      if (m) price = parseFloat(m[1].replace(/[^0-9.]/g,'')) || 0;
    }
    if (!price) {
      const pm = getMeta('product:price:amount','og:price:amount');
      if (pm) price = parseFloat(pm) || 0;
    }
    if (!price) {
      const m = html.match(/data-(?:product-)?price=["']([0-9]+(?:\.[0-9]{1,2})?)["']/i);
      if (m) price = parseFloat(m[1]) || 0;
    }
  } catch(e) {}

  // --- Strategy 2: Microlink API as fallback ---
  const needFallback = !title || !image;
  if (needFallback) {
    try {
      const ml = await fetch('https://api.microlink.io/?url=' + encodeURIComponent(url) + '&screenshot=true');
      const mj = await ml.json();
      if (mj.status === 'success' && mj.data) {
        const d = mj.data;
        if (!title && d.title) title = d.title.split(/\s*[|–—·•]\s*/)[0].trim();
        if (!image) image = (d.image && d.image.url) || (d.screenshot && d.screenshot.url) || '';
        if (!store && d.publisher) store = d.publisher;
        if (!price && d.price) price = parseFloat(String(d.price).replace(/[^0-9.]/g,'')) || 0;
      }
    } catch(e) {}
  }

  // Store fallback from domain
  if (!store) {
    try {
      const h = new URL(url).hostname.replace('www.','');
      const part = h.split('.')[0];
      store = part.charAt(0).toUpperCase() + part.slice(1);
    } catch(e) {}
  }

  res.json({ title, image, store, price: price || 0 });
}
