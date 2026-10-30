import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The page a person is on: its title is not the name of any file on it. */
export const PAGE_TITLE = 'Annual Report 2026 - Example Corp';

/** The bytes of a fixture file: the same bytes every run, so a checksum can be compared. */
export const body = (name: string, size: number): Buffer => {
  const chunk = createHash('sha256').update(name).digest();
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = chunk[i % chunk.length] ?? 0;
  return out;
};
export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

export const FILES = {
  report: { path: '/files/report.zip', size: 600_000 },
  paper: { path: '/files/paper.pdf', size: 300_000 },
  gated: { path: '/gated/members.zip', size: 200_000 },
  video: { path: '/files/clip.mp4', size: 500_000 },
  attachment: { path: '/attach/export.bin', size: 150_000 },
} as const;

export interface Site {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** Requests the site has seen, by path (to prove what was and was not requested). */
  seen: string[];
  /** Makes requests to `/expiring/*` fail, as a link that has expired; `renew` makes them work again. */
  expire(): void;
  renew(): void;
  stop(): Promise<void>;
}

function html(res: ServerResponse, text: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(text);
}

/** Serves bytes, with ranges, so the daemon can download in segments. */
function bytes(req: IncomingMessage, res: ServerResponse, data: Buffer, type: string): void {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const headers = { 'content-type': type, 'accept-ranges': 'bytes' };
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'content-length': data.length });
    res.end();
    return;
  }
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    res.writeHead(206, {
      ...headers,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${data.length}`,
    });
    res.end(data.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': data.length });
  res.end(data);
}

export async function startSite(): Promise<Site> {
  let expired = false;
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push(`${req.method} ${url.pathname}`);
    const route = url.pathname;
    if (route === '/page') {
      return html(
        res,
        `<!doctype html><title>${PAGE_TITLE}</title>
<h1>Downloads</h1>
<ul>
 <li><a href="${FILES.report.path}">Download the full report</a></li>
 <li><a href="/r1">Download the paper (PDF)</a></li>
 <li><a href="/logout">Log out</a></li>
 <li><a href="/fake.zip">Download the broken archive</a></li>
</ul>
<video src="${FILES.video.path}" controls></video>`,
      );
    }
    if (route === '/attachments') {
      return html(
        res,
        `<!doctype html><title>Attachments</title><a id="export" href="${FILES.attachment.path}">Export data</a>`,
      );
    }
    if (route === '/members') {
      return html(
        res,
        `<!doctype html><title>Members area</title><a href="${FILES.gated.path}">Download members archive</a>`,
      );
    }
    if (route === '/expiring-page') {
      return html(
        res,
        `<!doctype html><title>Expiring downloads</title><a id="fresh" href="/expiring/file.zip">Get a fresh link</a>`,
      );
    }
    if (route === '/magnets') {
      return html(
        res,
        `<!doctype html><title>Magnets</title><a id="magnet" href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=fixture">Magnet</a>`,
      );
    }
    if (route === '/stream') {
      return html(
        res,
        `<!doctype html><title>Live stream page</title><video id="v" controls></video>
<script>fetch('/hls/master.m3u8').then(r => r.text());</script>`,
      );
    }
    if (route === '/hls/master.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return void res.end(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n',
      );
    }
    if (route === '/hls/low.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return void res.end(
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg0.ts\n#EXT-X-ENDLIST\n',
      );
    }
    if (route === '/hls/seg0.ts') return bytes(req, res, body('seg0', 20_000), 'video/mp2t');
    if (route === '/r1') {
      res.writeHead(302, { location: '/r2' });
      return void res.end();
    }
    if (route === '/r2') {
      res.writeHead(307, { location: FILES.paper.path });
      return void res.end();
    }
    if (route === FILES.report.path)
      return bytes(req, res, body('report', FILES.report.size), 'application/zip');
    if (route === FILES.paper.path)
      return bytes(req, res, body('paper', FILES.paper.size), 'application/pdf');
    if (route === FILES.video.path)
      return bytes(req, res, body('video', FILES.video.size), 'video/mp4');
    if (route === FILES.attachment.path) {
      const data = body('attachment', FILES.attachment.size);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="export_final_v2.bin"',
        'content-length': data.length,
        'accept-ranges': 'bytes',
      });
      return void res.end(req.method === 'HEAD' ? undefined : data);
    }
    if (route === FILES.gated.path) {
      if (!/(^|;\s*)sid=ok(;|$)/.test(req.headers.cookie ?? '')) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return void res.end('sign in first');
      }
      return bytes(req, res, body('gated', FILES.gated.size), 'application/zip');
    }
    if (route === '/fake.zip') return html(res, '<html>not an archive</html>');
    if (route === '/expiring/file.zip') {
      if (expired) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return void res.end('this link has expired');
      }
      const data = body('expiring', 400_000);
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="expiring.zip"',
        'content-length': data.length,
      });
      return void res.end(req.method === 'HEAD' ? undefined : data);
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    seen,
    expire: () => {
      expired = true;
    },
    renew: () => {
      expired = false;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
