'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_REDIRECTS = 6;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
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

function isPokiHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'poki.com' || host === 'www.poki.com' || host.endsWith('.poki.com');
}

function localPokiUrl(resolved, localPokiOrigin) {
  const local = new URL(localPokiOrigin);
  const host = resolved.hostname.toLowerCase();
  local.hostname = host === 'poki.com' || host === 'www.poki.com'
    ? 'poki.localhost'
    : host.slice(0, -'.poki.com'.length) + '.poki.localhost';
  local.pathname = resolved.pathname;
  local.search = resolved.search;
  local.hash = resolved.hash;
  return local.href;
}

function proxyUrl(value, base, localPokiOrigin = null) {
  try {
    const resolved = new URL(value, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return value;
    const source = new URL(base);
    // Keep Poki's real URL path visible to its SPA router through a local virtual host.
    if (localPokiOrigin && isPokiHost(source.hostname) && isPokiHost(resolved.hostname)) {
      return localPokiUrl(resolved, localPokiOrigin);
    }
    return '/proxy?url=' + encodeURIComponent(resolved.href) + '&referer=' + encodeURIComponent(source.href);
  } catch { return value; }
}

function rewriteCss(css, base, localPokiOrigin = null) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole, quote, value) => {
    const raw = value.trim();
    if (!raw || /^(data:|blob:|#|about:|javascript:)/i.test(raw)) return whole;
    return 'url("' + proxyUrl(raw, base, localPokiOrigin).replace(/"/g, '%22') + '")';
  }).replace(/@import\s+(?:url\()?\s*(['"])(.*?)\1\s*\)?/gi,
    (whole, quote, value) => '@import url("' + proxyUrl(value, base, localPokiOrigin) + '")');
}

function rewriteHtml(html, base, localPokiOrigin = null) {
  // Protect JavaScript bodies while rewriting HTML attributes. Global HTML
  // regexes can otherwise match text like "src=" inside script strings and
  // corrupt site bundles, causing SyntaxError and broken UI icons.
  const scriptBodies = [];
  html = html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
    (_whole, opening, body, closing) => {
      const token = 'WARP_SCRIPT_BODY_' + scriptBodies.length + '_END';
      scriptBodies.push(body);
      return opening + token + closing;
    });
  html = html.replace(/<base\b[^>]*>/gi, '');
  // Rewrite common URL-bearing attributes so resources and navigation stay
  // on the local origin. This is a compatibility proxy, not a full browser engine.
  html = html.replace(/\b(href|src|action|poster|data|formaction)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (whole, attribute, quoted, doubleValue, singleValue, bareValue) => {
      const value = doubleValue ?? singleValue ?? bareValue ?? '';
      if (!value || /^(data:|blob:|#|javascript:|mailto:|tel:|about:)/i.test(value)) return whole;
      const rewritten = proxyUrl(value, base, localPokiOrigin);
      const quote = quoted[0] === '"' || quoted[0] === "'" ? quoted[0] : '"';
      return attribute + '=' + quote + rewritten.replace(new RegExp(quote, 'g'), '%22') + quote;
    });
  html = html.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (whole, quoted, a, b) => {
    const value = a ?? b ?? '';
    // Srcset candidates are comma-separated; do not split commas inside common
    // CDN query strings (for example ?format=webp,quality=80).
    const rewritten = value.split(/,\s+/).map((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts[0]) parts[0] = proxyUrl(parts[0], base, localPokiOrigin);
      return parts.join(' ');
    }).join(', ');
    const quote = quoted[0];
    return 'srcset=' + quote + rewritten + quote;
  });
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_whole, attrs, css) => '<style' + attrs + '>' + rewriteCss(css, base, localPokiOrigin) + '</style>');
  html = html.replace(/\sstyle=(["'])(.*?)\1/gi,
    (_whole, quote, css) => ' style=' + quote + rewriteCss(css, base, localPokiOrigin) + quote);

  const bootstrap = `<script>
(() => {
  const originalBase = ${JSON.stringify(base)};
  const localPokiOrigin = ${JSON.stringify(localPokiOrigin)};
  // Send the upstream URL to the WARP chrome. The parent verifies both this
  // iframe's window identity and the local virtual-host origin before accepting it.
  const reportNavigation = (mode = 'replace', value = null) => {
    try {
      let upstream = new URL(originalBase);
      const current = new URL(location.href);
      if (localPokiOrigin && (current.hostname === 'poki.localhost' || current.hostname.endsWith('.poki.localhost'))) {
        upstream = current;
        upstream.protocol = 'https:';
        upstream.hostname = upstream.hostname === 'poki.localhost'
          ? 'www.poki.com'
          : upstream.hostname.slice(0, -'.poki.localhost'.length) + '.poki.com';
      } else if (value !== null && value !== undefined && String(value)) {
        const candidate = new URL(String(value), originalBase);
        if (candidate.pathname === '/proxy' && candidate.searchParams.has('url')) {
          upstream = new URL(candidate.searchParams.get('url'));
        } else if (candidate.origin === location.origin) {
          upstream = new URL(candidate.pathname + candidate.search + candidate.hash, originalBase);
        } else {
          upstream = candidate;
        }
      }
      if (!['http:', 'https:'].includes(upstream.protocol)) return;
      parent.postMessage({ type: 'warp:navigate', url: upstream.href, mode }, '*');
    } catch { /* A URL that cannot be reported must not interrupt the site. */ }
  };
  const originalPushState = history.pushState.bind(history);
  history.pushState = function(state, title, url) {
    const result = originalPushState(state, title, url);
    reportNavigation('push', url == null ? null : url);
    return result;
  };
  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function(state, title, url) {
    const result = originalReplaceState(state, title, url);
    reportNavigation('replace', url == null ? null : url);
    return result;
  };
  addEventListener('popstate', () => reportNavigation('replace', location.href));
  addEventListener('hashchange', () => reportNavigation('push', location.href));
  addEventListener('load', () => reportNavigation('replace'));
  reportNavigation('replace');
  const isPokiHost = (hostname) => {
    const host = String(hostname || '').toLowerCase();
    return host === 'poki.com' || host === 'www.poki.com' || host.endsWith('.poki.com');
  };
  const isLocalPokiHost = (hostname) => {
    const host = String(hostname || '').toLowerCase();
    return host === 'poki.localhost' || host.endsWith('.poki.localhost');
  };
  const localPokiUrl = (u) => {
    const local = new URL(localPokiOrigin);
    const host = u.hostname.toLowerCase();
    local.hostname = host === 'poki.com' || host === 'www.poki.com'
      ? 'poki.localhost'
      : host.slice(0, -'.poki.com'.length) + '.poki.localhost';
    local.pathname = u.pathname;
    local.search = u.search;
    local.hash = u.hash;
    return local.href;
  };
  const proxy = (value) => {
    const raw = typeof value === 'string' ? value
      : value instanceof URL ? value.href
      : value instanceof Request ? value.url
      : value && typeof value.url === 'string' ? value.url
      : null;
    if (typeof raw !== 'string' || /^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(raw)) return value;
    try {
      // Avoid wrapping an already-proxied URL, including URLs on sibling
      // Poki virtual hosts and URL objects passed to fetch().
      const local = new URL(raw, location.href);
      const localOrigin = localPokiOrigin ? new URL(localPokiOrigin) : null;
      if (localOrigin && isLocalPokiHost(local.hostname) &&
          local.protocol === localOrigin.protocol && local.port === localOrigin.port) return raw;
      if (local.origin === location.origin && local.pathname === '/proxy' &&
          local.searchParams.has('url')) return raw;
      // Reinterpret local-origin URL objects against the upstream page, not WARP itself.
      const u = local.origin === location.origin
        ? new URL(local.pathname + local.search + local.hash, originalBase)
        : new URL(raw, originalBase);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return value;
      if (localPokiOrigin && isPokiHost(new URL(originalBase).hostname) && isPokiHost(u.hostname)) {
        return localPokiUrl(u);
      }
      return '/proxy?url=' + encodeURIComponent(u.href) + '&referer=' + encodeURIComponent(originalBase);
    } catch { return value; }
  };
  const proxySrcset = (value) => String(value).split(/,\\s+/).map((entry) => {
    const parts = entry.trim().split(/\\s+/);
    if (parts[0]) parts[0] = proxy(parts[0]);
    return parts.join(' ');
  }).join(', ');
  const rewriteCssValue = (value) => String(value).replace(/url\\(\\s*(['"]?)(.*?)\\1\\s*\\)/gi, (whole, quote, raw) => {
    const url = raw.trim();
    if (!url || /^(data:|blob:|#|about:|javascript:)/i.test(url)) return whole;
    return 'url("' + String(proxy(url)).replace(/"/g, '%22') + '")';
  });
  // Static HTML rewriting cannot see URLs assigned later by app code. Poki
  // creates some icons/images dynamically, so route URL attributes through the
  // same proxy when code uses setAttribute() or common DOM URL properties.
  const oldSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (typeof value === 'string') {
      if (/^srcset$/i.test(name)) value = proxySrcset(value);
      else if (/^style$/i.test(name)) value = rewriteCssValue(value);
      else if (/^(src|href|poster|action|formaction|data)$/i.test(name)) value = proxy(value);
    }
    return oldSetAttribute.call(this, name, value);
  };
  const patchUrlProperty = (prototype, property) => {
    if (!prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor || !descriptor.get || !descriptor.set || !descriptor.configurable) return;
    Object.defineProperty(prototype, property, {
      ...descriptor,
      set(value) {
        if (typeof value !== 'string') return descriptor.set.call(this, value);
        const next = property === 'srcset' ? proxySrcset(value) : proxy(value);
        return descriptor.set.call(this, next);
      }
    });
  };
  patchUrlProperty(window.HTMLImageElement && HTMLImageElement.prototype, 'src');
  patchUrlProperty(window.HTMLImageElement && HTMLImageElement.prototype, 'srcset');
  patchUrlProperty(window.HTMLSourceElement && HTMLSourceElement.prototype, 'srcset');
  patchUrlProperty(window.HTMLScriptElement && HTMLScriptElement.prototype, 'src');
  patchUrlProperty(window.HTMLLinkElement && HTMLLinkElement.prototype, 'href');
  patchUrlProperty(window.HTMLSourceElement && HTMLSourceElement.prototype, 'src');
  patchUrlProperty(window.HTMLMediaElement && HTMLMediaElement.prototype, 'src');
  patchUrlProperty(window.HTMLMediaElement && HTMLMediaElement.prototype, 'poster');
  patchUrlProperty(window.HTMLAnchorElement && HTMLAnchorElement.prototype, 'href');
  patchUrlProperty(window.HTMLFormElement && HTMLFormElement.prototype, 'action');
  const oldSetProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function(name, value, priority) {
    return oldSetProperty.call(this, name, rewriteCssValue(value), priority);
  };
  // Property assignments such as element.style.backgroundImage bypass
  // setAttribute()/setProperty(); observe the resulting style attribute too.
  const rewriteDynamicNode = (node) => {
    if (!(node instanceof Element)) return;
    for (const name of ['srcset', 'style']) {
      if (!node.hasAttribute(name)) continue;
      const value = node.getAttribute(name);
      const next = name === 'srcset' ? proxySrcset(value) : rewriteCssValue(value);
      if (next !== value) node.setAttribute(name, next);
    }
    if (node.querySelectorAll) node.querySelectorAll('[srcset],[style]').forEach(rewriteDynamicNode);
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') rewriteDynamicNode(record.target);
      for (const node of record.addedNodes || []) rewriteDynamicNode(node);
    }
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['srcset', 'style']
  });
  const oldFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const next = proxy(input);
    // Preserve method, headers, credentials, and body when callers pass a
    // Request object; reducing it to a URL silently breaks POST telemetry/API calls.
    if (input instanceof Request && typeof next === 'string' && next !== input.url) {
      return oldFetch(new Request(next, input), init);
    }
    return oldFetch(next, init);
  };
  const oldOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return oldOpen.call(this, method, proxy(url), ...rest);
  };
  const oldOpenWindow = window.open;
  window.open = (url, ...args) => oldOpenWindow.call(window, proxy(url), ...args);
  // React/Vue-style routers inspect anchor.href before the browser navigates.
  // Since rewritten links point at /proxy?url=..., the app can mistake that
  // local proxy endpoint for a real game route (Poki then shows "game moved").
  // Take over these navigations in capture phase before the site's router sees them.
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
    let destination;
    try { destination = new URL(link.href, location.href); } catch { return; }
    if (destination.origin !== location.origin || destination.pathname !== '/proxy' ||
        !destination.searchParams.has('url')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    location.assign(destination.pathname + destination.search + destination.hash);
  }, true);
})();
</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) html = html.slice(0, head.index + head[0].length) + bootstrap + html.slice(head.index + head[0].length);
  else html = bootstrap + html;
  html = html.replace(/WARP_SCRIPT_BODY_(\d+)_END/g, (_whole, index) => scriptBodies[Number(index)] ?? _whole);
  return html;
}

async function readRequestBody(req, limit) {
  const chunks = [];
  let length = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new Error('Request body is too large for the local browser proxy.');
  return Buffer.concat(chunks, length);
}

async function handlePokiPathProxy(req, res) {
  const requestHost = String(req.headers.host || '').split(':')[0].toLowerCase();
  let upstreamHost;
  if (requestHost === 'poki.localhost') {
    upstreamHost = 'www.poki.com';
  } else if (requestHost.endsWith('.poki.localhost')) {
    upstreamHost = requestHost.slice(0, -'.localhost'.length) + '.com';
  } else {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid Poki host.');
    return;
  }

  let target;
  try {
    target = new URL(req.url, 'https://' + upstreamHost);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid Poki path.');
    return;
  }
  if (target.origin !== 'https://' + upstreamHost || !isPokiHost(target.hostname)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid Poki path.');
    return;
  }
  const forwarded = Object.create(req);
  forwarded.url = '/proxy?url=' + encodeURIComponent(target.href);
  return handleWebProxy(forwarded, res);
}

async function handleWebProxy(req, res) {
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD, POST' }).end('Only GET, HEAD, and POST are supported by this browser proxy.');
    return;
  }

  const requestUrl = new URL(req.url, 'http://localhost');
  const initial = requestUrl.searchParams.get('url');
  let referer;
  try {
    const candidate = new URL(requestUrl.searchParams.get('referer') || '');
    if (candidate.protocol === 'http:' || candidate.protocol === 'https:') referer = candidate.href;
  } catch { /* Ignore invalid optional referrers. */ }
  if (!initial) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Missing url parameter.');
    return;
  }

  try {
    const requestBody = req.method === 'POST' ? await readRequestBody(req, MAX_REQUEST_BODY_BYTES) : undefined;
    let target = await validateTarget(initial);
    let upstream;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      upstream = await fetch(target, {
        method: req.method,
        ...(requestBody !== undefined ? { body: requestBody } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: req.headers.accept || '*/*',
          'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
          ...(referer ? { Referer: referer } : {}),
          ...(req.method === 'POST' && referer ? { Origin: new URL(referer).origin } : {}),
          ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
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
    const requestHost = String(req.headers.host || '').split(':')[0].toLowerCase();
    const localPokiOrigin = requestHost === 'poki.localhost' || requestHost.endsWith('.poki.localhost')
      ? 'http://' + req.headers.host
      : null;
    if (location) headers.Location = proxyUrl(location, target, localPokiOrigin);
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
      body = isHtml
        ? rewriteHtml(body, target.href, localPokiOrigin)
        : rewriteCss(body, target.href, localPokiOrigin);
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
    // Fetch failures otherwise look identical in the browser console. Log only
    // the method, destination hostname, and network error code (never query data).
    let failedHost = 'invalid-url';
    try { failedHost = new URL(initial).hostname; } catch { /* Keep safe fallback. */ }
    console.error('[WARP proxy]', req.method, failedHost, error.cause?.code || error.name, error.message);
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    const status = /private destinations|Only HTTP|credentials/.test(error.message) ? 403 :
      /valid website URL|Missing url/.test(error.message) ? 400 :
      /Request body is too large/.test(error.message) ? 413 : 502;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('WARP could not load this site. ' + error.message);
  }
}

module.exports = { handleWebProxy, handlePokiPathProxy, validateTarget, rewriteHtml, rewriteCss, proxyUrl };
