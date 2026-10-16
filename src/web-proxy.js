'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_REDIRECTS = 6;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const PRIVATE_V4_CIDRS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => (value * 256) + Number(part), 0) >>> 0;
}

function isInIpv4Range(address, network, prefix) {
  const shift = 32 - prefix;
  return (ipv4Number(address) >>> shift) === (ipv4Number(network) >>> shift);
}

function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return !PRIVATE_V4_CIDRS.some(([network, prefix]) => isInIpv4Range(address, network, prefix));
  if (version === 6) {
    const value = address.toLowerCase();
    // Permit globally routable IPv6 only; reject loopback, unspecified,
    // IPv4-mapped, unique-local, link-local, and documentation ranges.
    return !(value === '::' || value === '::1' || value.startsWith('::ffff:') ||
      value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') ||
      value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') ||
      value.startsWith('2001:db8:') || value.startsWith('ff'));
  }
  return false;
}

async function validateTarget(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter a valid website URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP and HTTPS sites are supported.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not supported.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Local and private destinations are blocked.');
  }
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error('Local and private destinations are blocked.');
  } else {
    let records;
    try { records = await dns.lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error('The website hostname could not be resolved.'); }
    if (!records.length || records.some((record) => !isPublicAddress(record.address))) {
      throw new Error('Local and private destinations are blocked.');
    }
  }
  return url;
}

function proxyUrl(value, base) {
  try {
    const resolved = new URL(value, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return value;
    // Preserve the source page as a referrer for CDNs that hotlink-protect images.
    return '/proxy?url=' + encodeURIComponent(resolved.href) + '&referer=' + encodeURIComponent(new URL(base).href);
  } catch { return value; }
}

function rewriteCss(css, base) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole, quote, value) => {
    const raw = value.trim();
    if (!raw || /^(data:|blob:|#|about:|javascript:)/i.test(raw)) return whole;
    return 'url("' + proxyUrl(raw, base).replace(/"/g, '%22') + '")';
  }).replace(/@import\s+(?:url\()?\s*(['"])(.*?)\1\s*\)?/gi,
    (whole, quote, value) => '@import url("' + proxyUrl(value, base) + '")');
}

function rewriteHtml(html, base) {
  // Rewrite common URL-bearing attributes so resources and navigation stay
  // on the local origin. This is a compatibility proxy, not a full browser engine.
  html = html.replace(/\b(href|src|action|poster|data|formaction)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (whole, attribute, quoted, doubleValue, singleValue, bareValue) => {
      const value = doubleValue ?? singleValue ?? bareValue ?? '';
      if (!value || /^(data:|blob:|#|javascript:|mailto:|tel:|about:)/i.test(value)) return whole;
      const rewritten = proxyUrl(value, base);
      const quote = quoted[0] === '"' || quoted[0] === "'" ? quoted[0] : '"';
      return attribute + '=' + quote + rewritten.replace(new RegExp(quote, 'g'), '%22') + quote;
    });
  html = html.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (whole, quoted, a, b) => {
    const value = a ?? b ?? '';
    // Srcset candidates are comma-separated; do not split commas inside common
    // CDN query strings (for example ?format=webp,quality=80).
    const rewritten = value.split(/,\s+/).map((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts[0]) parts[0] = proxyUrl(parts[0], base);
      return parts.join(' ');
    }).join(', ');
    const quote = quoted[0];
    return 'srcset=' + quote + rewritten + quote;
  });
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_whole, attrs, css) => '<style' + attrs + '>' + rewriteCss(css, base) + '</style>');
  html = html.replace(/\sstyle=(["'])(.*?)\1/gi,
    (_whole, quote, css) => ' style=' + quote + rewriteCss(css, base) + quote);

  const bootstrap = `<script>
(() => {
  const originalBase = ${JSON.stringify(base)};
  const proxy = (value) => {
    try {
      const u = new URL(typeof value === 'string' ? value : value.url, originalBase);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return value;
      return '/proxy?url=' + encodeURIComponent(u.href) + '&referer=' + encodeURIComponent(originalBase);
    } catch { return value; }
  };
  const oldFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const next = proxy(input);
    return oldFetch(next, init);
  };
  const oldOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return oldOpen.call(this, method, proxy(url), ...rest);
  };
  const oldOpenWindow = window.open;
  window.open = (url, ...args) => oldOpenWindow.call(window, proxy(url), ...args);
  document.addEventListener('click', (event) => {
    const link = event.target.closest && event.target.closest('a[href]');
    if (link && !event.defaultPrevented && link.target !== '_blank') {
      const u = new URL(link.href, location.href);
      if (u.origin === location.origin && u.pathname === '/proxy') return;
    }
  }, true);
})();
</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) html = html.slice(0, head.index + head[0].length) + bootstrap + html.slice(head.index + head[0].length);
  else html = bootstrap + html;
  return html;
}

async function handleWebProxy(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' }).end('Only GET and HEAD are supported by this browser proxy.');
    return;
  }

  const requestUrl = new URL(req.url, 'http://localhost');
  const initial = requestUrl.searchParams.get('url');
  if (!initial) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Missing url parameter.');
    return;
  }

  try {
    let target = await validateTarget(initial);
    let upstream;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      upstream = await fetch(target, {
        method: req.method,
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: req.headers.accept || '*/*',
          'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
          ...(requestUrl.searchParams.has('referer') ? { Referer: (() => {
            try {
              const referrer = new URL(requestUrl.searchParams.get('referer'));
              return referrer.protocol === 'http:' || referrer.protocol === 'https:' ? referrer.href : undefined;
            } catch { return undefined; }
          })() } : {}),
          ...(req.headers.range ? { Range: req.headers.range } : {}),
          ...(req.headers['if-none-match'] ? { 'If-None-Match': req.headers['if-none-match'] } : {}),
          ...(req.headers['if-modified-since'] ? { 'If-Modified-Since': req.headers['if-modified-since'] } : {})
        }
      });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get('location');
      if (!location || redirects === MAX_REDIRECTS) break;
      target = await validateTarget(new URL(location, target).href);
    }

    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Cache-Control': /text\/html|text\/css/i.test(type) ? 'no-store' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    };
    for (const name of ['content-range', 'accept-ranges', 'last-modified', 'etag', 'content-disposition']) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    const location = upstream.headers.get('location');
    if (location) headers.Location = proxyUrl(location, target);
    if (upstream.status === 204 || upstream.status === 304) {
      res.writeHead(upstream.status, headers).end();
      return;
    }
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(type);
    const isCss = /text\/css/i.test(type);
    if (isHtml || isCss) {
      const declaredLength = Number(upstream.headers.get('content-length') || 0);
      if (declaredLength > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Page is too large for the local browser proxy.');
        return;
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Page is too large for the local browser proxy.');
        return;
      }
      let body = bytes.toString(/charset=([^;]+)/i.exec(type)?.[1] || 'utf-8');
      body = isHtml ? rewriteHtml(body, target.href) : rewriteCss(body, target.href);
      res.writeHead(upstream.status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    if (req.method === 'HEAD' || !upstream.body) {
      res.writeHead(upstream.status, headers);
      res.end();
      return;
    }
    // Stream binary assets instead of buffering the entire image/video/font in
    // memory. This removes the old 20 MB limit that silently broke large assets.
    res.writeHead(upstream.status, headers);
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    const status = /private destinations|Only HTTP|credentials/.test(error.message) ? 403 :
      /valid website URL|Missing url/.test(error.message) ? 400 : 502;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('WARP could not load this site. ' + error.message);
  }
}

module.exports = { handleWebProxy, validateTarget, rewriteHtml, rewriteCss };
