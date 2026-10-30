import { describe, expect, it } from 'vitest';
import { ApiError, DlmClient, NetworkError, type FetchLike } from './client';
import { readSse } from './sse';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init });

function recorder(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = (url, init = {}) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  };
  return { calls, fetch };
}

function at<T>(list: T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe('DlmClient', () => {
  it('sends the token as a bearer header, and none for health', async () => {
    const { calls, fetch } = recorder(() =>
      json({
        status: 'ok',
        version: '0.6.0',
        apiVersion: 1,
        minClientApi: 1,
        authenticated: false,
      }),
    );
    const client = new DlmClient({
      baseUrl: 'http://127.0.0.1:5',
      token: 'dlmt_secretsecret1',
      fetch,
    });
    const health = await client.health();
    expect(health.apiVersion).toBe(1);
    expect(headersOf(at(calls, 0).init).Authorization).toBeUndefined();
    await client.whoami().catch(() => undefined);
    expect(headersOf(at(calls, 1).init).Authorization).toBe('Bearer dlmt_secretsecret1');
    expect(at(calls, 1).url).toBe('http://127.0.0.1:5/v1/auth/whoami');
  });

  it('posts JSON for capture', async () => {
    const { calls, fetch } = recorder(() =>
      json({ task: { id: 't1' }, refreshed: false }, { status: 201 }),
    );
    const client = new DlmClient({ baseUrl: 'https://h.test/dlm', token: 't', fetch });
    await client.capture({ url: 'https://example.test/a.zip', pageUrl: 'https://example.test/' });
    const call = at(calls, 0);
    expect(call.url).toBe('https://h.test/dlm/v1/capture');
    expect(call.init.method).toBe('POST');
    expect(headersOf(call.init)['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.init.body as string)).toEqual({
      url: 'https://example.test/a.zip',
      pageUrl: 'https://example.test/',
    });
  });

  it('builds the task query, joining lists with commas', async () => {
    const { calls, fetch } = recorder(() => json({ tasks: [] }));
    const client = new DlmClient({ baseUrl: 'http://h', token: 't', fetch });
    await client.listTasks({ status: ['running', 'awaiting_link'], q: 'a b' });
    expect(at(calls, 0).url).toBe('http://h/v1/tasks?status=running%2Cawaiting_link&q=a+b');
  });

  it('turns problem details into an ApiError with the code, without secrets', async () => {
    const { fetch } = recorder(() =>
      json(
        {
          status: 409,
          code: 'task.duplicate',
          detail: 'already have https://u:p@h.test/x?token=abc',
        },
        { status: 409 },
      ),
    );
    const client = new DlmClient({ baseUrl: 'http://h', token: 't', fetch });
    const error = await client.capture({ url: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const api = error as ApiError;
    expect([api.status, api.code]).toEqual([409, 'task.duplicate']);
    expect(api.message).not.toContain('u:p@');
    expect(api.message).not.toContain('token=abc');
  });

  it('reports 401 and Retry-After', async () => {
    const { fetch } = recorder(() => new Response('nope', { status: 401 }));
    const client = new DlmClient({ baseUrl: 'http://h', token: 't', fetch });
    const e = (await client.whoami().catch((x: unknown) => x)) as ApiError;
    expect(e.unauthorized).toBe(true);
    const limited = recorder(() =>
      json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '3' } }),
    );
    const c2 = new DlmClient({ baseUrl: 'http://h', token: 't', fetch: limited.fetch });
    expect(((await c2.whoami().catch((x: unknown) => x)) as ApiError).retryAfter).toBe(3);
  });

  it('says NetworkError when the daemon cannot be reached, never naming the token', async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    const client = new DlmClient({
      baseUrl: 'http://127.0.0.1:9',
      token: 'dlmt_secretsecret1',
      fetch,
    });
    const e = (await client.health().catch((x: unknown) => x)) as NetworkError;
    expect(e).toBeInstanceOf(NetworkError);
    expect(e.message).toContain('127.0.0.1:9');
    expect(e.message).not.toContain('dlmt_');
  });

  it('times out', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const client = new DlmClient({ baseUrl: 'http://h', token: 't', fetch, timeoutMs: 20 });
    const e = (await client.health().catch((x: unknown) => x)) as NetworkError;
    expect(e).toBeInstanceOf(NetworkError);
    expect(e.timedOut).toBe(true);
  });

  it('streams events with the token and resumes from the last id', async () => {
    const stream = (text: string) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        }),
      );
    const { calls, fetch } = recorder(() =>
      stream('id: b-1\nevent: task.status\ndata: {"a":1}\n\n'),
    );
    const client = new DlmClient({ baseUrl: 'http://h', token: 'tok', fetch });
    const seen = [];
    for await (const ev of client.events({ lastEventId: 'b-0', types: ['task.status', 'reset'] }))
      seen.push(ev);
    expect(seen).toEqual([{ id: 'b-1', event: 'task.status', data: '{"a":1}' }]);
    expect(at(calls, 0).url).toBe('http://h/v1/events?types=task.status%2Creset');
    expect(headersOf(at(calls, 0).init)['Last-Event-ID']).toBe('b-0');
    expect(headersOf(at(calls, 0).init).Authorization).toBe('Bearer tok');
  });
});

describe('readSse', () => {
  const chunks = (parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(new TextEncoder().encode(p));
        controller.close();
      },
    });
  const all = async (parts: string[]) => {
    const out = [];
    for await (const e of readSse(chunks(parts))) out.push(e);
    return out;
  };

  it('parses frames split anywhere, CRLF, comments and multi-line data', async () => {
    const text =
      ': ping\r\nid: 1\r\nevent: a\r\ndata: x\r\ndata: y\r\n\r\ndata: z\n\n: only a comment\n\n';
    const whole = await all([text]);
    expect(whole).toEqual([
      { id: '1', event: 'a', data: 'x\ny' },
      { id: '1', event: 'message', data: 'z' },
    ]);
    for (const size of [1, 2, 3, 7]) {
      const parts = text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];
      expect(await all(parts)).toEqual(whole);
    }
  });

  it('skips frames without data', async () => {
    expect(await all(['event: reset\n\n'])).toEqual([]);
  });
});

describe('DlmClient requests', () => {
  const ok = () => json({});
  const run = async (call: (client: DlmClient) => Promise<unknown>) => {
    const { calls, fetch } = recorder(ok);
    await call(new DlmClient({ baseUrl: 'http://127.0.0.1:5', token: 't', fetch }));
    const first = at(calls, 0);
    return {
      method: first.init.method,
      url: first.url,
      body:
        typeof first.init.body === 'string'
          ? (JSON.parse(first.init.body) as unknown)
          : first.init.body,
      headers: headersOf(first.init),
    };
  };

  it('lists tasks with a query, joining lists with commas and leaving empty values out', async () => {
    const sent = await run((c) => c.listTasks({ status: ['awaiting_link', 'error'], limit: 5 }));
    expect(sent.method).toBe('GET');
    expect(sent.url).toBe('http://127.0.0.1:5/v1/tasks?status=awaiting_link%2Cerror&limit=5');
    expect((await run((c) => c.listTasks())).url).toBe('http://127.0.0.1:5/v1/tasks');
  });

  it('asks for one task, escaping its id', async () => {
    expect((await run((c) => c.getTask('a/b'))).url).toBe('http://127.0.0.1:5/v1/tasks/a%2Fb');
  });

  it.each([
    ['createTask', (c: DlmClient) => c.createTask({ url: 'magnet:?xt=1' }), 'POST', '/v1/tasks'],
    [
      'createTasks',
      (c: DlmClient) => c.createTasks({ items: [{ url: 'https://a.test/x' }] }),
      'POST',
      '/v1/tasks/batch',
    ],
    ['listQueues', (c: DlmClient) => c.listQueues(), 'GET', '/v1/queues'],
    ['limits', (c: DlmClient) => c.limits(), 'GET', '/v1/limits'],
    [
      'moveTasks',
      (c: DlmClient) => c.moveTasks({ ids: ['1'], queueId: 'q' }),
      'POST',
      '/v1/tasks/move',
    ],
    ['pauseTasks', (c: DlmClient) => c.pauseTasks({ ids: ['1'] }), 'POST', '/v1/tasks/pause'],
    ['resumeTasks', (c: DlmClient) => c.resumeTasks({ ids: ['1'] }), 'POST', '/v1/tasks/resume'],
    ['resolve', (c: DlmClient) => c.resolve({ url: 'https://a.test/x' }), 'POST', '/v1/resolve'],
  ] as const)('%s uses its endpoint', async (_name, call, method, path) => {
    const sent = await run(call);
    expect(sent.method).toBe(method);
    expect(sent.url).toBe(`http://127.0.0.1:5${path}`);
    expect(sent.headers.Authorization).toBe('Bearer t');
  });

  it('turns turbo on for an hour and off again', async () => {
    const on = await run((c) => c.turbo(true));
    expect(on).toMatchObject({ method: 'POST', body: { speedLimit: 0, minutes: 60 } });
    expect(on.url).toBe('http://127.0.0.1:5/v1/limits/override');
    expect(await run((c) => c.turbo(false))).toMatchObject({ method: 'DELETE' });
  });

  it('imports cookies as the daemon’s JSON format', async () => {
    const sent = await run((c) => c.importCookies([{ domain: 'a.test', name: 'sid', value: 'x' }]));
    expect(sent.url).toBe('http://127.0.0.1:5/v1/cookies/import');
    const body = sent.body as { format: string; data: string };
    expect(body.format).toBe('json');
    expect(JSON.parse(body.data)).toEqual([{ domain: 'a.test', name: 'sid', value: 'x' }]);
  });

  it('uploads a torrent as its own content type, with the options in the query', async () => {
    const sent = await run((c) =>
      c.addTorrentFile(new Uint8Array([1, 2, 3]), {
        queueId: 'q',
        name: 'a.torrent',
        paused: true,
      }),
    );
    expect(sent.url).toBe(
      'http://127.0.0.1:5/v1/tasks/torrent?queueId=q&name=a.torrent&paused=true',
    );
    expect(sent.headers['Content-Type']).toBe('application/x-bittorrent');
    expect((await run((c) => c.addTorrentFile(new Uint8Array([1])))).url).toBe(
      'http://127.0.0.1:5/v1/tasks/torrent',
    );
  });

  it('opens the event stream with the last event id and the types asked for', async () => {
    const { calls, fetch } = recorder(
      () =>
        new Response('id: 1\nevent: ping\ndata: {}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    );
    const client = new DlmClient({ baseUrl: 'http://127.0.0.1:5', token: 't', fetch });
    const seen: string[] = [];
    for await (const event of client.events({
      lastEventId: '7',
      types: ['task.updated', 'reset'],
    })) {
      seen.push(event.event ?? '');
    }
    expect(at(calls, 0).url).toBe('http://127.0.0.1:5/v1/events?types=task.updated%2Creset');
    expect(headersOf(at(calls, 0).init)['Last-Event-ID']).toBe('7');
    expect(seen).toEqual(['ping']);
  });

  it('says so when the event stream has no body', async () => {
    const { fetch } = recorder(() => new Response(null, { status: 200 }));
    const client = new DlmClient({ baseUrl: 'http://127.0.0.1:5', token: 't', fetch });
    await expect(client.events().next()).rejects.toBeInstanceOf(NetworkError);
  });
});
