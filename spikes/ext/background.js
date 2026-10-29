// Spike extension: runs the measurement the config asks for and reports to the collector.
// Plain JavaScript on purpose: it must run unmodified in Chrome (service worker) and Firefox (event page).
const api = globalThis.browser ?? globalThis.chrome;
const boot = Math.random().toString(36).slice(2, 8);
let cfg;
let C;
let topLevelEvents = 0;
// A listener registered synchronously at load, as an event page requires.
try {
  api.webRequest.onHeadersReceived.addListener(
    () => {
      topLevelEvents++;
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  );
} catch (e) {
  console.log('SPIKE|' + JSON.stringify({ name: 'toplevel_listener_error', error: String(e) }));
}

function say(name, data) {
  const line = JSON.stringify({ t: Date.now(), boot, name, ...data });
  console.log('SPIKE|' + line);
  return fetch(`${C}/report`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: line,
  }).catch(() => {});
}

async function t(name, fn) {
  try {
    await say(name, { ok: true, ...(await fn()) });
  } catch (e) {
    await say(name, { ok: false, error: String(e), errName: e?.name });
  }
}

// Everything the download spike observes is registered synchronously at load: an event page (Firefox) does
// not deliver webRequest events to listeners that are added later, after an await.
const dl = { events: [], t0: 0, action: 'observe', recording: false };
const isFirefox = typeof globalThis.browser !== 'undefined';
dl.ev = (type, d) => {
  if (dl.recording) dl.events.push({ ms: Math.round(performance.now() - dl.t0), type, ...d });
};
api.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (!d.url.startsWith('http://127.0.0.1:18080/')) return undefined;
    const disp = d.responseHeaders?.find(
      (h) => h.name.toLowerCase() === 'content-disposition',
    )?.value;
    const ct = d.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value;
    dl.ev('headersReceived', { url: d.url, status: d.statusCode, type: d.type, disp, ct });
    if (dl.action === 'block' && disp && /attachment/i.test(disp)) return { cancel: true };
    return undefined;
  },
  { urls: ['<all_urls>'] },
  isFirefox ? ['blocking', 'responseHeaders'] : ['responseHeaders'],
);
api.downloads.onCreated.addListener((item) => {
  dl.ev('created', {
    id: item.id,
    url: item.url,
    finalUrl: item.finalUrl ?? null,
    referrer: item.referrer ?? null,
    mime: item.mime,
    state: item.state,
    byExt: item.byExtensionId ?? null,
    incognito: item.incognito,
  });
  if (dl.action === 'cancel') {
    api.downloads
      .cancel(item.id)
      .then(() => {
        dl.ev('cancelled', { id: item.id });
        return api.downloads.erase({ id: item.id });
      })
      .then((erased) => dl.ev('erased', { erased }))
      .catch((e) => dl.ev('cancel-error', { error: String(e) }));
  }
});
api.downloads.onChanged.addListener((d) =>
  dl.ev('changed', { id: d.id, state: d.state?.current, error: d.error?.current }),
);
if (api.downloads.onDeterminingFilename) {
  api.downloads.onDeterminingFilename.addListener((item, suggest) => {
    dl.ev('determiningFilename', { id: item.id, filename: item.filename });
    suggest();
  });
}

const json = async (r) => ({ status: r.status, text: (await r.text()).slice(0, 300) });

async function apiTests() {
  const D = cfg.daemon;
  const auth = { authorization: `Bearer ${D.token}` };
  await say('env', { origin: location.origin, ua: navigator.userAgent, id: api.runtime.id });
  await t('permissions', async () => ({
    all: await api.permissions.getAll(),
    containsAllUrls: await api.permissions.contains({ origins: ['<all_urls>'] }),
    containsLoopback: await api.permissions.contains({ origins: ['http://127.0.0.1/*'] }),
  }));
  await t('webrequest_toplevel', async () => {
    const tab = await api.tabs.create({ url: `${C}/file/inline.txt` });
    await new Promise((r) => setTimeout(r, 2000));
    await api.tabs.remove(tab.id);
    return { eventsSeen: topLevelEvents };
  });
  await t('loopback_simple', async () => {
    const r = await fetch(`${C}/echo`);
    return { status: r.status, echo: await r.json() };
  });
  await t('loopback_post_json_auth', async () => {
    const r = await fetch(`${C}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: '{}',
    });
    return { status: r.status };
  });
  for (const space of ['loopback', 'local']) {
    await t(`loopback_targetAddressSpace_${space}`, async () => {
      const r = await fetch(`${C}/echo`, { targetAddressSpace: space });
      return { status: r.status };
    });
  }
  await t('daemon_health', async () => json(await fetch(`${D.url}/v1/health`)));
  await t('daemon_no_token', async () => json(await fetch(`${D.url}/v1/tasks`)));
  await t('daemon_get_authed', async () =>
    json(await fetch(`${D.url}/v1/tasks`, { headers: auth })),
  );
  await t('daemon_post_json_authed', async () =>
    json(
      await fetch(`${D.url}/v1/capture`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          url: `${C}/file/inline.txt`,
          pageUrl: `${C}/page/link`,
          paused: true,
        }),
      }),
    ),
  );
  await t('daemon_if_match', async () =>
    json(await fetch(`${D.url}/v1/tasks`, { headers: { ...auth, 'if-match': '"x"' } })),
  );
  await t('daemon_sse_headers', async () => {
    const ctl = new AbortController();
    const r = await fetch(`${D.url}/v1/events`, { headers: auth, signal: ctl.signal });
    const reader = r.body.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise((res) => setTimeout(() => res({ timeout: true }), 3000)),
    ]);
    ctl.abort();
    return { status: r.status, ct: r.headers.get('content-type'), gotChunk: !first.timeout };
  });
  await say('done', {});
}

async function downloadTests() {
  const events = dl.events;
  dl.action = cfg.action; // observe | cancel | block (firefox)
  dl.recording = true;
  const scenarios = [
    ['attachment', () => api.tabs.create({ url: `${C}/file/attachment.bin` })],
    ['redirect_to_attachment', () => api.tabs.create({ url: `${C}/file/redirect` })],
    ['octet_no_disposition', () => api.tabs.create({ url: `${C}/file/octet-no-disposition.bin` })],
    ['inline_text', () => api.tabs.create({ url: `${C}/file/inline.txt` })],
    ['blob_download', () => api.tabs.create({ url: `${C}/page/blob` })],
    [
      'extension_download',
      () => api.downloads.download({ url: `${C}/file/attachment.bin`, filename: 'ext.bin' }),
    ],
  ];
  for (const [name, run] of scenarios) {
    events.length = 0;
    dl.t0 = performance.now();
    let tab;
    try {
      tab = await run();
    } catch (e) {
      dl.ev('trigger-error', { error: String(e) });
    }
    await new Promise((r) => setTimeout(r, 6000));
    const items = await api.downloads.search({});
    await say(`download_${name}`, {
      action: dl.action,
      events: [...events],
      remaining: items.map((i) => ({
        id: i.id,
        state: i.state,
        bytes: i.bytesReceived,
        error: i.error,
        exists: i.exists,
        filename: i.filename,
      })),
    });
    if (tab?.id) await api.tabs.remove(tab.id).catch(() => {});
    for (const i of items) await api.downloads.erase({ id: i.id }).catch(() => {});
  }
  await say('done', {});
}

async function lifetime() {
  const phase = cfg.phase;
  const beat = () => fetch(`${C}/beat?phase=${phase}&boot=${boot}`).catch(() => {});
  setInterval(beat, 2000);
  beat();
  await say('lifetime_start', { phase });
  if (phase === 'native') {
    const port = api.runtime.connectNative('dev.sabadia.dlm');
    port.onMessage.addListener((m) =>
      say('native_msg', { m: JSON.stringify(m).replace(/"token":"[^"]*"/, '"token":"…"') }),
    );
    port.onDisconnect.addListener(() =>
      say('native_disconnect', { err: String(api.runtime.lastError?.message) }),
    );
    port.postMessage({ type: 'connect' });
    setInterval(() => port.postMessage({ type: 'ping' }), 20000);
  } else if (phase === 'sse') {
    const r = await fetch(`${cfg.daemon.url}/v1/events`, {
      headers: { authorization: `Bearer ${cfg.daemon.token}` },
    });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        await say('sse_closed', {});
        break;
      }
      await say('sse_chunk', { n: value.length });
    }
  } else if (phase === 'alarms') {
    api.alarms.create('beat', { periodInMinutes: 0.5 });
    api.alarms.onAlarm.addListener(() => say('alarm', {}));
  }
}

async function main() {
  cfg = await (await fetch(api.runtime.getURL('config.json'))).json();
  C = cfg.collector;
  if (cfg.waitForGo)
    for (;;) {
      const r = await fetch(`${C}/go`).catch(() => null);
      if (r?.status === 200) break;
      await new Promise((res) => setTimeout(res, 500));
    }
  if (cfg.mode === 'api') await apiTests();
  else if (cfg.mode === 'downloads') await downloadTests();
  else if (cfg.mode === 'lifetime') await lifetime();
}
// Listeners must be registered at the top level; the work starts on install/startup.
api.runtime.onInstalled.addListener(() => {
  main().catch((e) => console.log('SPIKE|' + JSON.stringify({ name: 'fatal', error: String(e) })));
});
api.runtime.onStartup.addListener(() => {
  main().catch(() => {});
});
