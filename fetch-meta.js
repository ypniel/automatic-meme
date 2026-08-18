export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL' });

  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  let html = '';
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });
    html = await r.text();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Extract <meta> content by property or name attribute
  const getMeta = (...props) => {
    for (const prop of props) {
      // property/name before content
      let m = html.match(new RegExp('<meta[^>]*(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)["\']', 'i'));
      if (m) return m[1].trim();
      // content before property/name
      m = html.match(new RegExp('<meta[^>]*content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i'));
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

  // ---- TITLE ----
  let title = getMeta('og:title', 'twitter:title');
  if (!title) {
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    title = m ? m[1] : '';
  }
  title = title.replace(/&#?[a-z0-9]+;/gi, ' ').split(/\s*[|–—·•]\s*/)[0].trim();

  // ---- IMAGE ----
  let image = getMeta('og:image', 'og:image:url', 'twitter:image');

  if (!image) {
    const m = html.match(/<(?:meta|link)[^>]*itemprop=["']image["'][^>]*(?:content|href)=["']([^"']+)["']/i)
           || html.match(/<(?:meta|link)[^>]*(?:content|href)=["']([^"']+)["'][^>]*itemprop=["']image["']/i);
    if (m) image = m[1];
  }

  if (!image) {
    const ldBlock = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (ldBlock) {
      try {
        const obj = JSON.parse(ldBlock[1]);
        const findImg = (o) => {
          if (!o || typeof o !== 'object') return '';
          if (o.image) {
            const img = Array.isArray(o.image) ? o.image[0] : o.image;
            return typeof img === 'string' ? img : (img.url || '');
          }
          for (const v of Object.values(o)) { const r = findImg(v); if (r) return r; }
          return '';
        };
        image = [].concat(obj).reduce((acc, o) => acc || findImg(o), '');
      } catch(e) {}
    }
  }

  image = absUrl(image);

  // ---- STORE ----
  const store = getMeta('og:site_name') || (() => {
    try {
      const h = new URL(url).hostname.replace('www.', '');
      const part = h.split('.')[0];
      return part.charAt(0).toUpperCase() + part.slice(1);
    } catch(e) { return ''; }
  })();

  // ---- PRICE ----
  let price = 0;

  // 1. JSON-LD structured data
  const ldBlocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of ldBlocks) {
    if (price) break;
    try {
      const findPrice = (o) => {
        if (!o || typeof o !== 'object') return;
        if (['Product', 'Offer', 'AggregateOffer'].includes(o['@type'])) {
          const off = o.offers ? (Array.isArray(o.offers) ? o.offers[0] : o.offers) : o;
          const p = off.price !== undefined ? off.price : off.lowPrice;
          if (p !== undefined && p !== null) {
            price = parseFloat(String(p).replace(/[^0-9.]/g, ''));
            return;
          }
        }
        for (const v of Object.values(o)) findPrice(v);
      };
      [].concat(JSON.parse(block[1])).forEach(findPrice);
    } catch(e) {}
  }

  // 2. itemprop="price" meta tag
  if (!price) {
    const m = html.match(/<meta[^>]*itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*itemprop=["']price["']/i);
    if (m) price = parseFloat(m[1].replace(/[^0-9.]/g, '')) || 0;
  }

  // 3. og:price:amount / product:price:amount
  if (!price) {
    const pm = getMeta('product:price:amount', 'og:price:amount');
    if (pm) price = parseFloat(pm) || 0;
  }

  // 4. data-price attribute
  if (!price) {
    const m = html.match(/data-(?:product-)?price=["']([0-9]+(?:\.[0-9]{1,2})?)["']/i);
    if (m) price = parseFloat(m[1]) || 0;
  }

  // 5. itemprop=price with content on any element
  if (!price) {
    const m = html.match(/<[^>]+itemprop=["']price["'][^>]*content=["']([^"']+)["']/i);
    if (m) price = parseFloat(m[1].replace(/[^0-9.]/g, '')) || 0;
  }

  res.json({ title, image, store, price: price || 0 });
}
