// Runs one spike against a real browser and a real daemon.
//   node spikes/run.mjs <chrome|firefox> <api|downloads|lifetime> [--origins] [--action=observe|cancel|block]
//                       [--phase=idle|native|sse|alarms] [--seconds=N] [--out=name]
// Needs: dlm on PATH (or DLM), Google Chrome, or FIREFOX=/path/to/Firefox.app. Temp files go to SPIKE_TMP.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startCollector } from './collector.mjs';

const [browser, mode, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(
  rest.map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]),
);
const here = path.dirname(new URL(import.meta.url).pathname);
const tmp = mkdtempSync(path.join(process.env.SPIKE_TMP ?? tmpdir(), 'spike-'));
const DLM = process.env.DLM ?? 'dlm';
const FF_UUID = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fixed Chrome key so the extension id is the same on every run.
const keyFile = path.join(here, 'ext', 'chrome.key.pub');
if (!existsSync(keyFile)) {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(keyFile, publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
}
const keyB64 = readFileSync(keyFile, 'utf8').trim();
const extId = [
  ...createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex').slice(0, 32),
]
  .map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)))
  .join('');
const origin = browser === 'chrome' ? `chrome-extension://${extId}` : `moz-extension://${FF_UUID}`;

// 1. the daemon
const home = path.join(tmp, 'daemon');
const env = { ...process.env };
if (opt.origins) env.DLM_SERVER_ALLOWED_ORIGINS = origin;
const daemon = spawn(DLM, ['serve', '--home', home, '--address', '127.0.0.1:0', '--log-stderr'], {
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
});
const daemonErr = [];
daemon.stderr.on('data', (d) => daemonErr.push(String(d)));
const runtimeFile = path.join(home, 'config', 'runtime.json');
for (let i = 0; i < 100 && !existsSync(runtimeFile); i++) await sleep(100);
const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'));
const token = readFileSync(path.join(home, 'config', 'token'), 'utf8').trim();
const daemonUrl = runtime.url ?? `http://${runtime.address}`;

// 2. the collector
const logFile = path.join(tmp, 'collector.ndjson');
const { server } = await startCollector({ port: 18080, logFile });

// 3. the extension directory
const extDir = path.join(tmp, 'ext');
mkdirSync(extDir);
copyFileSync(path.join(here, 'ext', 'background.js'), path.join(extDir, 'background.js'));
const manifest = JSON.parse(
  readFileSync(path.join(here, 'ext', `manifest.${browser}.json`), 'utf8'),
);
if (browser === 'chrome') manifest.key = keyB64;
writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(
  path.join(extDir, 'config.json'),
  JSON.stringify({
    mode,
    action: opt.action ?? 'observe',
    phase: opt.phase ?? 'idle',
    collector: 'http://127.0.0.1:18080',
    daemon: { url: daemonUrl, token },
  }),
);

// 4. the browser
const downloads = path.join(tmp, 'downloads');
mkdirSync(downloads);
const profile = path.join(tmp, 'profile');
mkdirSync(path.join(profile, 'Default'), { recursive: true });
const spikeLines = [];
let proc;
if (browser === 'chrome') {
  writeFileSync(
    path.join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloads, prompt_for_download: false },
      savefile: { default_directory: downloads },
    }),
  );
  if (opt.phase === 'native') {
    const hosts = path.join(profile, 'NativeMessagingHosts');
    mkdirSync(hosts);
    const launcher = path.join(hosts, 'dlm-host.sh');
    writeFileSync(
      launcher,
      `#!/bin/sh\n${opt.origins ? `export DLM_SERVER_ALLOWED_ORIGINS=${origin}\n` : ''}exec ${DLM} native-host --home ${home} --server ${daemonUrl} "$@"\n`,
    );
    chmodSync(launcher, 0o755);
    writeFileSync(
      path.join(hosts, 'dev.sabadia.dlm.json'),
      JSON.stringify({
        name: 'dev.sabadia.dlm',
        description: 'spike',
        path: launcher,
        type: 'stdio',
        allowed_origins: [`${origin}/`],
      }),
    );
  }
  const chrome =
    process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  proc = spawn(
    chrome,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${extDir}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-logging=stderr',
      '--v=0',
      ...(opt.headful ? [] : ['--headless=new']),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let buf = '';
  proc.stderr.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      const i = l.indexOf('SPIKE|');
      if (i >= 0) spikeLines.push(l.slice(i + 6).replace(/", source: .*$/, ''));
    }
  });
} else {
  const ffApp = process.env.FIREFOX ?? '/Applications/Firefox.app';
  const prefs = [
    `extensions.webextensions.uuids={"dlm-spike@example.org":"${FF_UUID}"}`,
    'browser.download.folderList=2',
    `browser.download.dir=${downloads}`,
    'browser.download.useDownloadDir=true',
    'browser.shell.checkDefaultBrowser=false',
    'datareporting.policy.dataSubmissionEnabled=false',
    'extensions.autoDisableScopes=0',
    ...(process.env.FF_PREFS ? process.env.FF_PREFS.split(';') : []),
  ];
  proc = spawn(
    'pnpm',
    [
      'exec',
      'web-ext',
      'run',
      '--firefox',
      path.join(ffApp, 'Contents/MacOS/firefox'),
      '--source-dir',
      extDir,
      '--no-input',
      '--no-reload',
      '--profile-create-if-missing',
      '--firefox-profile',
      profile,
      ...prefs.flatMap((p) => ['--pref', p]),
      ...(opt.headful ? [] : ['--arg=-headless']),
      '--start-url',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  proc.stderr.on('data', () => {});
}

// Firefox keeps host permissions optional; a user who accepts the install prompt grants them. Do the same
// from the privileged side through Marionette, then let the extension start.
async function marionetteGrant() {
  const sock = net.connect(2828, '127.0.0.1');
  const failed = new Promise((_, rej) => sock.on('error', rej));
  let buf = Buffer.alloc(0);
  const waiters = [];
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const i = buf.indexOf(':');
      if (i < 0) return;
      const len = Number(buf.slice(0, i));
      if (buf.length < i + 1 + len) return;
      const msg = JSON.parse(buf.slice(i + 1, i + 1 + len).toString());
      buf = buf.slice(i + 1 + len);
      waiters.shift()?.(msg);
    }
  });
  const next = () => Promise.race([new Promise((r) => waiters.push(r)), failed]);
  const send = async (id, name, params) => {
    const body = JSON.stringify([0, id, name, params]);
    const p = next();
    sock.write(`${Buffer.byteLength(body)}:${body}`);
    return p;
  };
  await next(); // greeting
  await send(1, 'WebDriver:NewSession', { capabilities: {} });
  await send(2, 'Marionette:SetContext', { value: 'chrome' });
  const script = `const done = arguments[arguments.length - 1];
    (async () => {
      const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
      const policy = WebExtensionPolicy.getByID('dlm-spike@example.org');
      await ExtensionPermissions.add('dlm-spike@example.org', { permissions: [], origins: ['<all_urls>'] }, policy.extension);
      return JSON.stringify(policy.allowedOrigins.patterns.map((p) => p.pattern));
    })().then(done, (e) => done('ERR ' + e));`;
  const res = await send(3, 'WebDriver:ExecuteAsyncScript', { script, args: [], newSandbox: true });
  sock.destroy();
  return res;
}
if (browser === 'firefox' && !opt.nogrant) {
  let granted;
  for (let i = 0; i < 60 && !granted; i++) {
    await sleep(1000);
    try {
      const r = await marionetteGrant();
      const v = JSON.stringify(r);
      if (!v.includes('ERR') && !v.includes('error')) granted = v;
      else if (i % 10 === 9) console.log('grant retry:', v.slice(0, 200));
    } catch (e) {
      if (i % 10 === 9) console.log('marionette not ready:', String(e).slice(0, 80));
    }
  }
  console.log('firefox grant:', granted ?? 'FAILED');
  await fetch('http://127.0.0.1:18080/go?set=1');
}

// 5. wait for the result
const seconds = Number(opt.seconds ?? (mode === 'lifetime' ? 130 : 90));
const t0 = Date.now();
const reports = () =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
while (Date.now() - t0 < seconds * 1000) {
  await sleep(1000);
  if (
    mode !== 'lifetime' &&
    (reports().some((r) => r.kind === 'report' && JSON.parse(r.body).name === 'done') ||
      spikeLines.some((l) => l.includes('"name":"done"')))
  )
    break;
}
await sleep(1500);

const all = reports();
const fromReports = all.filter((r) => r.kind === 'report').map((r) => JSON.parse(r.body));
const fromConsole = spikeLines.map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return { raw: l };
  }
});
const result = {
  browser,
  mode,
  options: opt,
  extId,
  origin,
  daemonUrl,
  reports: fromReports,
  console: fromConsole,
  collectorRequests: all.filter(
    (r) => r.kind === 'request' && !r.path.startsWith('/beat') && r.path !== '/report',
  ),
  beats: all
    .filter((r) => r.kind === 'beat')
    .map((r) => ({ t: r.t - t0, boot: r.boot, phase: r.phase })),
  downloadDirFiles: readdirSync(downloads),
  daemonStderrTail: daemonErr.join('').split('\n').filter(Boolean).slice(-15),
};
mkdirSync(path.join(here, 'results'), { recursive: true });
const out = path.join(
  here,
  'results',
  `${opt.out ?? `${browser}-${mode}${opt.origins ? '-origins' : ''}${opt.action ? '-' + opt.action : ''}${opt.phase ? '-' + opt.phase : ''}`}.json`,
);
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(
  `wrote ${path.relative(process.cwd(), out)}: ${fromReports.length} reports, ${fromConsole.length} console lines, ${result.beats.length} beats`,
);
proc.kill('SIGTERM');
daemon.kill('SIGTERM');
server.close();
await sleep(500);
process.exit(0);
