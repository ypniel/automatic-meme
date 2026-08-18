export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url, debug } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL' });

  let title = '', image = '', store = '', price = 0;
  let hostname = '';
  try { hostname = new URL(url).hostname.replace('www.', ''); } catch(e) {}

  const UA_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const UA_GOOGLE = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  const extractMeta = (html, ...props) => {
    for (const prop of props) {
      const m = html.match(new RegExp('<meta[^>]*(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)["\']', 'i'))
             || html.match(new RegExp('<meta[^>]*content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i'));
      if (m) return m[1].trim();
    }
    return '';
  };
  const absUrl = (src, base) => {
    if (!src) return '';
    if (src.startsWith('//')) return 'https:' + src;
    if (src.startsWith('http')) return src;
    try { return new URL(src, base || url).href; } catch(e) { return src; }
  };
  const parseHtml = (html, baseUrl) => {
    let t = extractMeta(html, 'og:title', 'twitter:title');
    if (!t) { const m = html.match(/<title[^>]*>([^<]+)<\/title>/i); t = m ? m[1] : ''; }
    t = t.replace(/&#?[a-z0-9]+;/gi, ' ').replace(/&amp;/gi,' ').split(/\s*[|–—·•]\s*/)[0].trim();
    let img = absUrl(extractMeta(html, 'og:image', 'og:image:url', 'twitter:image'), baseUrl);
    if (!img) {
      const m = html.match(/<[^>]+itemprop=["']image["'][^>]*(?:content|href)=["']([^"']+)["']/i);
      if (m) img = absUrl(m[1], baseUrl);
    }
    let st = extractMeta(html, 'og:site_name');
    let p = 0;
    // JSON-LD price
    for (const block of [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]) {
      if (p) break;
      try {
        const findP = (o) => {
          if (!o || typeof o !== 'object') return;
          if (['Product','Offer','AggregateOffer'].includes(o['@type'])) {
            const off = o.offers ? (Array.isArray(o.offers) ? o.offers[0] : o.offers) : o;
            const v = off.price !== undefined ? off.price : off.lowPrice;
            if (v != null) { p = parseFloat(String(v).replace(/[^0-9.]/g,'')); return; }
          }
          for (const v of Object.values(o)) findP(v);
        };
        [].concat(JSON.parse(block[1])).forEach(findP);
      } catch(e) {}
    }
    // itemprop price
    if (!p) {
      const m = html.match(/<meta[^>]*itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)
             || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*itemprop=["']price["']/i);
      if (m) p = parseFloat(m[1].replace(/[^0-9.]/g,'')) || 0;
    }
    if (!p) {
      const pm = extractMeta(html, 'product:price:amount', 'og:price:amount');
      if (pm) p = parseFloat(pm) || 0;
    }
    return { title: t, image: img, store: st, price: p };
  };

  // ─── 0. Site-specific handlers ───────────────────────────────────────────────

  // IKEA — search API (no Cloudflare on this endpoint)
  if (hostname.includes('ikea.com')) {
    store = 'IKEA';
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      const last  = parts[parts.length - 1] || '';
      const itemNo = last.replace(/^s/, '').replace(/[^0-9]/g, '');
      if (itemNo) {
        const r = await fetch(
          `https://sik.search.blue.cdtapps.com/au/en/search-result-page?types=PRODUCT&q=${itemNo}&size=1&c=plp&v=20211213`,
          { headers: { Accept: 'application/json', 'User-Agent': UA_CHROME } }
        );
        const d = await r.json();
        const item = d?.searchResultPage?.products?.main?.items?.[0]?.product;
        if (item) {
          title  = item.name || item.typeName || '';
          image  = item.contextualImageUrl || item.mainImageUrl || item.media?.[0]?.href || '';
          price  = parseFloat(item.salesPrice?.numeral || item.price?.numeral || 0) || 0;
          if (!price && item.salesPrice?.wholeNumber) price = parseFloat(item.salesPrice.wholeNumber);
        }
      }
    } catch(e) {}
  }

  // Kmart AU — product ID from URL → their internal JSON API
  else if (hostname.includes('kmart.com.au')) {
    store = 'Kmart';
    try {
      // URL: /product/{name}-{id}/ — ID is the last hyphenated number
      const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
      const idMatch = slug.match(/-(\d{6,})$/);
      const pid = idMatch ? idMatch[1] : '';
      if (pid) {
        // Try Kmart's internal product API
        const r = await fetch(
          `https://www.kmart.com.au/api/2.0/page/product?id=${pid}`,
          { headers: { 'User-Agent': UA_CHROME, Accept: 'application/json',
                       Referer: 'https://www.kmart.com.au/' } }
        );
        if (r.ok) {
          const d = await r.json();
          const prod = d?.product || d?.data?.product || d;
          title = prod?.name || prod?.title || '';
          image = prod?.images?.[0]?.href || prod?.image?.href || prod?.primaryImage || '';
          price = parseFloat(prod?.priceRange?.min || prod?.price || 0) || 0;
        }
      }
    } catch(e) {}
  }

  // Target AU — similar to Kmart (also Wesfarmers)
  else if (hostname.includes('target.com.au')) {
    store = 'Target';
    try {
      const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
      const idMatch = slug.match(/-(\d{6,})$/) || url.match(/[?&]pid=(\d+)/);
      const pid = idMatch ? idMatch[1] : '';
      if (pid) {
        const r = await fetch(
          `https://www.target.com.au/api/2.0/page/product?id=${pid}`,
          { headers: { 'User-Agent': UA_CHROME, Accept: 'application/json',
                       Referer: 'https://www.target.com.au/' } }
        );
        if (r.ok) {
          const d = await r.json();
          const prod = d?.product || d?.data?.product || d;
          title = prod?.name || '';
          image = prod?.images?.[0]?.href || '';
          price = parseFloat(prod?.priceRange?.min || prod?.price || 0) || 0;
        }
      }
    } catch(e) {}
  }

  // Chemist Warehouse — product ID from /buy/{id}/... URL
  else if (hostname.includes('chemistwarehouse')) {
    store = 'Chemist Warehouse';
    try {
      const m = url.match(/\/buy\/(\d+)\//);
      const pid = m ? m[1] : '';
      if (pid) {
        const r = await fetch(
          `https://www.chemistwarehouse.com.au/api/2.0/page/product?id=${pid}`,
          { headers: { 'User-Agent': UA_CHROME, Accept: 'application/json',
                       Referer: 'https://www.chemistwarehouse.com.au/', 'X-Requested-With': 'XMLHttpRequest' } }
        );
        if (r.ok) {
          const d = await r.json();
          title = d?.product?.name || d?.name || '';
          image = d?.product?.images?.[0]?.url || d?.images?.[0]?.url || '';
          price = parseFloat(d?.product?.price || d?.price || 0) || 0;
        }
      }
    } catch(e) {}
  }

  // Amazon — allorigins proxy (different IP from Vercel's)
  else if (hostname.includes('amazon.')) {
    store = 'Amazon';
    try {
      const pr = await fetch(
        'https://api.allorigins.win/get?url=' + encodeURIComponent(url),
        { headers: { 'User-Agent': UA_CHROME } }
      );
      const pj = await pr.json();
      if (pj.contents) {
        const parsed = parseHtml(pj.contents, url);
        title = parsed.title; image = parsed.image;
        if (!store) store = parsed.store;
        price = parsed.price;
      }
    } catch(e) {}
  }

  // Shopify stores — try /products/{handle}.json (Best Buy Electrical, BBNT, Adairs, etc.)
  if (!title) {
    try {
      const urlObj = new URL(url);
      const parts = urlObj.pathname.split('/').filter(Boolean);
      const prodIdx = parts.lastIndexOf('products');
      const handle  = prodIdx >= 0 && parts[prodIdx + 1] ? parts[prodIdx + 1] : parts[parts.length - 1];
      if (handle) {
        const jsonUrl = `${urlObj.origin}/products/${handle}.json`;
        const r = await fetch(jsonUrl, { headers: { 'User-Agent': UA_GOOGLE, Accept: 'application/json' } });
        if (r.ok) {
          const d = await r.json();
          const p = d.product;
          if (p && p.title) {
            title = p.title;
            if (!store) {
              const part = urlObj.hostname.replace('www.', '').split('.')[0];
              store = { bedbathntable: 'Bed Bath N Table', adairs: 'Adairs',
                        bestbuyelectrical: 'Best Buy Electrical' }[part]
                   || (part.charAt(0).toUpperCase() + part.slice(1));
            }
            if (p.images?.[0]) image = p.images[0].src;
            if (p.variants?.[0]) price = parseFloat(p.variants[0].price) || 0;
          }
        }
      }
    } catch(e) {}
  }

  // ─── 1. Direct HTML fetch ─────────────────────────────────────────────────────
  if (!title || !image) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA_CHROME, Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
                   'Accept-Language': 'en-AU,en;q=0.9' },
        redirect: 'follow',
      });
      const html = await r.text();
      if (debug) return res.json({ html: html.slice(0, 5000) });
      const parsed = parseHtml(html, url);
      if (!title && parsed.title) title = parsed.title;
      if (!image && parsed.image) image = parsed.image;
      if (!store && parsed.store) store = parsed.store;
      if (!price && parsed.price) price = parsed.price;
    } catch(e) {}
  }

  // ─── 2. Wayback Machine — bypasses Cloudflare (uses archived copy) ────────────
  if (!title || !image) {
    try {
      const wbRes = await fetch(
        `https://archive.org/wayback/available?url=${encodeURIComponent(url.replace(/^https?:\/\/(www\.)?/, ''))}`,
        { headers: { 'User-Agent': UA_CHROME } }
      );
      const wbData = await wbRes.json();
      const snapshot = wbData?.archived_snapshots?.closest;
      if (snapshot?.available && snapshot?.url) {
        const pageRes = await fetch(snapshot.url, { headers: { 'User-Agent': UA_CHROME } });
        const html = await pageRes.text();
        const parsed = parseHtml(html, url);
        if (!title && parsed.title) title = parsed.title;
        if (!image && parsed.image) image = parsed.image;
        if (!store && parsed.store) store = parsed.store;
        if (!price && parsed.price) price = parsed.price;
      }
    } catch(e) {}
  }

  // ─── 3. allorigins.win proxy ──────────────────────────────────────────────────
  if (!title || !image) {
    try {
      const pr = await fetch('https://api.allorigins.win/get?url=' + encodeURIComponent(url));
      const pj = await pr.json();
      if (pj.contents && !pj.contents.includes('Just a moment')) {
        const parsed = parseHtml(pj.contents, url);
        if (!title && parsed.title) title = parsed.title;
        if (!image && parsed.image) image = parsed.image;
        if (!store && parsed.store) store = parsed.store;
        if (!price && parsed.price) price = parsed.price;
      }
    } catch(e) {}
  }

  // ─── 4. Microlink API ─────────────────────────────────────────────────────────
  if (!title || !image) {
    try {
      const ml = await fetch('https://api.microlink.io/?url=' + encodeURIComponent(url));
      const mj = await ml.json();
      if (mj.status === 'success' && mj.data) {
        const d = mj.data;
        if (!title && d.title) title = d.title.split(/\s*[|–—·•]\s*/)[0].trim();
        if (!image) image = d.image?.url || '';
        if (!store && d.publisher) store = d.publisher;
        if (!price && d.price) price = parseFloat(String(d.price).replace(/[^0-9.]/g,'')) || 0;
      }
    } catch(e) {}
  }

  // ─── Store name fallback ──────────────────────────────────────────────────────
  if (!store) {
    const knownStores = {
      ikea: 'IKEA', amazon: 'Amazon', kmart: 'Kmart', target: 'Target',
      chemistwarehouse: 'Chemist Warehouse', adairs: 'Adairs',
      bedbathntable: 'Bed Bath N Table', bestbuyelectrical: 'Best Buy Electrical',
      harveynorman: 'Harvey Norman', jbhifi: 'JB Hi-Fi', bunnings: 'Bunnings',
      myer: 'Myer', davidjones: 'David Jones', catch: 'Catch', ebay: 'eBay',
      theiconic: 'The Iconic', cottonon: 'Cotton On', uniqlo: 'Uniqlo'
    };
    try {
      const part = new URL(url).hostname.replace('www.', '').split('.')[0].toLowerCase();
      store = knownStores[part] || (part.charAt(0).toUpperCase() + part.slice(1));
    } catch(e) {}
  }

  // ─── Title fallback — URL slug ────────────────────────────────────────────────
  if (!title) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      const slug = parts[parts.length - 1] || parts[parts.length - 2] || '';
      const cleaned = slug.replace(/-[0-9]{5,}$/, '').replace(/-/g, ' ');
      title = cleaned.replace(/\b\w/g, c => c.toUpperCase()).trim();
    } catch(e) {}
  }

  res.json({ title, image, store, price: price || 0 });
}
