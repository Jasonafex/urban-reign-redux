export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle disc streaming via Cloudflare R2
    if (path === '/disc_redux.iso' || path === '/disc.iso') {
      const key = path === '/disc.iso' ? 'Urban Reign.iso' : 'Urban Reign Redux 0.4.iso';
      const range = request.headers.get('Range');

      if (!env.DISCS) {
        return new Response('DISCS R2 bucket binding not configured', { status: 500 });
      }

      if (request.method === 'HEAD') {
        const head = await env.DISCS.head(key);
        if (!head) {
          return new Response(`Disc ${key} not found in R2 bucket`, { status: 404 });
        }
        const headers = new Headers();
        head.writeHttpMetadata(headers);
        headers.set('ETag', head.httpEtag);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Content-Length', String(head.size));
        headers.set('Cross-Origin-Resource-Policy', 'same-origin');
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(null, { status: 200, headers });
      }

      const head = await env.DISCS.head(key);
      if (!head) {
        return new Response(`Disc ${key} not found in R2 bucket`, { status: 404 });
      }

      const headers = new Headers();
      head.writeHttpMetadata(headers);
      headers.set('ETag', head.httpEtag);
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      headers.set('Access-Control-Allow-Origin', '*');

      let options = {};
      let status = 200;

      if (range) {
        const match = range.match(/bytes=(\d*)-(\d*)/);
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0;
          const end = match[2] ? parseInt(match[2], 10) : head.size - 1;
          options.range = { offset: start, length: end - start + 1 };
          status = 206;
          headers.set('Content-Range', `bytes ${start}-${end}/${head.size}`);
          headers.set('Content-Length', String(options.range.length));
        }
      } else {
        headers.set('Content-Length', String(head.size));
      }

      const obj = await env.DISCS.get(key, options);
      return new Response(obj.body, { status, headers });
    }

    // Rewrite root / to /index.html or /ps2web.html
    let assetRequest = request;
    if (path === '/' || path === '') {
      assetRequest = new Request(new URL('/index.html', request.url), request);
    } else if (path === '/stock' || path === '/stock/') {
      assetRequest = new Request(new URL('/stock/index.html', request.url), request);
    }

    // Default static asset fetching with COOP/COEP isolation
    const response = await env.ASSETS.fetch(assetRequest);
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
    newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
    newHeaders.set('Cross-Origin-Resource-Policy', 'same-origin');
    if (path.startsWith('/chunks/')) {
      newHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
    return new Response(response.body, {
      status: response.status,
      headers: newHeaders,
    });
  },
};
