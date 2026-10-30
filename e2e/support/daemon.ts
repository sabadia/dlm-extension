import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** A real `dlm serve` in a temporary home, and the few calls the tests make to it directly. */
export interface Daemon {
  url: string;
  token: string;
  home: string;
  /** Where the daemon saves files. */
  downloads: string;
  command: string;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const dlmCommand = (): string => process.env.DLM ?? 'dlm';

/** Starts the daemon on a free port. `origin` is the extension origin its native host should accept. */
export async function startDaemon(home: string, origin: string): Promise<Daemon> {
  const command = dlmCommand();
  const downloads = path.join(home, 'downloads');
  mkdirSync(downloads, { recursive: true });
  const child: ChildProcess = spawn(
    command,
    ['serve', '--home', home, '--address', '127.0.0.1:0', '--log-stderr'],
    {
      env: { ...process.env, DLM_SERVER_ALLOWED_ORIGINS: origin },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  const errors: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => errors.push(String(chunk)));
  const runtimeFile = path.join(home, 'config', 'runtime.json');
  for (let i = 0; i < 150 && !existsSync(runtimeFile); i++) await sleep(100);
  if (!existsSync(runtimeFile)) {
    child.kill();
    throw new Error(`the daemon did not start: ${errors.join('').slice(-800)}`);
  }
  const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8')) as {
    url?: string;
    address: string;
  };
  const token = readFileSync(path.join(home, 'config', 'token'), 'utf8').trim();
  const url = runtime.url ?? `http://${runtime.address}`;

  const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  };

  for (let i = 0; i < 50; i++) {
    try {
      await api('GET', '/v1/health');
      break;
    } catch {
      await sleep(100);
    }
  }
  // Everything a test downloads goes below the temporary home, never into the person's own Downloads folder.
  await api('PATCH', '/v1/settings', { downloadDir: downloads });
  return {
    url,
    token,
    home,
    downloads,
    command,
    api,
    async stop() {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}
