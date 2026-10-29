// Spike collector: a loopback server that records what browsers send, serves download fixtures
// and collects the results the spike extension reports. Not part of the product.
import http from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

export function startCollector({ port = 18080, logFile }) {
  let go = false;
  const log = (kind, data) => {
    const line = JSON.stringify({ t: Date.now(), kind, ...data });
    if (logFile) appendFileSync(logFile, line + '\n');
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const h = req.headers;
    const seen = {
      method: req.method,
      path: url.pathname + url.search,
      origin: h.origin ?? null,
      secFetchSite: h['sec-fetch-site'] ?? null,
      secFetchMode: h['sec-fetch-mode'] ?? null,
      secFetchDest: h['sec-fetch-dest'] ?? null,
      host: h.host,
      acrPn: h['access-control-request-private-network'] ?? null,
      acrMethod: h['access-control-request-method'] ?? null,
      acrHeaders: h['access-control-request-headers'] ?? null,
      userAgent: h['user-agent'] ?? null,
    };
    log('request', seen);

    const cors = url.searchParams.get('cors') ?? 'reflect';
    const corsHeaders = {};
    if (cors === 'reflect' && h.origin) {
      corsHeaders['access-control-allow-origin'] = h.origin;
      corsHeaders['access-control-allow-headers'] = 'authorization,content-type';
      corsHeaders['access-control-allow-methods'] = 'GET,POST,OPTIONS';
      corsHeaders['access-control-allow-private-network'] = 'true';
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders).end();
      return;
    }

    if (url.pathname === '/go') {
      if (url.searchParams.has('set')) go = true;
      res.writeHead(go ? 200 : 204, { 'access-control-allow-origin': '*' }).end();
    } else if (url.pathname === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(seen));
    } else if (url.pathname === '/report' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        log('report', { body });
        res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
      });
    } else if (url.pathname === '/beat') {
      log('beat', { phase: url.searchParams.get('phase'), boot: url.searchParams.get('boot') });
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
    } else if (url.pathname === '/file/attachment.bin') {
      const size = 3 * 1024 * 1024;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="spike.bin"',
        'content-length': String(size),
      });
      let sent = 0;
      const timer = setInterval(() => {
        if (res.destroyed || sent >= size) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          return;
        }
        res.write(Buffer.alloc(16384, 7));
        sent += 16384;
      }, 20);
      res.on('close', () => {
        clearInterval(timer);
        log('file-closed', { path: url.pathname, sent, complete: sent >= size });
      });
    } else if (url.pathname === '/file/redirect') {
      res.writeHead(302, { location: '/file/attachment.bin' }).end();
    } else if (url.pathname === '/file/inline.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello inline');
    } else if (url.pathname === '/file/octet-no-disposition.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(200000, 1));
    } else if (url.pathname === '/page/blob') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>blob</title><script>
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([new Uint8Array(50000)], {type:'application/octet-stream'}));
        a.download = 'blob.bin'; document.body.append(a); a.click();
      </script>`);
    } else if (url.pathname === '/page/link') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>link</title><a id=l href="/file/attachment.bin">file</a>
        <a id=m href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567">magnet</a>`);
    } else {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, port, log })),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startCollector({ logFile: process.argv[2] });
  console.log(`collector on http://127.0.0.1:${port}`);
  if (process.argv[2]) writeFileSync(process.argv[2] + '.started', String(Date.now()));
}
