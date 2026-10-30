import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A raw connection to the browser's DevTools endpoint. Playwright cannot attach to an extension's service worker, and
 * the budgets need its heap and a way to stop it, so this talks the protocol itself (the browser is started with
 * `--remote-debugging-port=0`, which writes the port into the profile).
 */
export class Cdp {
  private nextId = 1;
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      const resolve = typeof message.id === 'number' ? this.waiting.get(message.id) : undefined;
      if (resolve && typeof message.id === 'number') {
        this.waiting.delete(message.id);
        resolve(message);
      }
    });
  }

  static async connect(profile: string): Promise<Cdp> {
    const [port, endpoint] = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8')
      .trim()
      .split('\n');
    const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('could not reach DevTools')));
    });
    return new Cdp(socket);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else resolve((message.result ?? {}) as T);
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** The addresses of the targets of one type that are running. */
  async targets(type: string): Promise<string[]> {
    const { targetInfos } = await this.send<{ targetInfos: { type: string; url: string }[] }>(
      'Target.getTargets',
    );
    return targetInfos.filter((item) => item.type === type).map((item) => item.url);
  }

  /** Attaches to the first target whose address starts with `urlPrefix`, and returns the session id. */
  async attach(type: string, urlPrefix: string): Promise<string> {
    const { targetInfos } = await this.send<{
      targetInfos: { targetId: string; type: string; url: string }[];
    }>('Target.getTargets');
    const target = targetInfos.find((item) => item.type === type && item.url.startsWith(urlPrefix));
    if (!target) throw new Error(`no ${type} target at ${urlPrefix}`);
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    return sessionId;
  }

  close(): void {
    this.socket.close();
  }
}
