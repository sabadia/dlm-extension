import { describe, expect, it } from 'vitest';
import { silentLog } from '../log/log';
import { DownloadsService } from './service';

describe('DownloadsService.test', () => {
  it('has DLM download its own health report, and refuses when DLM is not connected', async () => {
    const added: string[] = [];
    const live = new DownloadsService({
      secrets: { get: () => Promise.resolve('t') },
      connection: {
        get: () =>
          Promise.resolve({
            kind: 'connected',
            targetId: 'local',
            baseUrl: 'http://127.0.0.1:50123',
            version: '0.6.0',
          } as const),
      },
      log: silentLog,
      add: (_base, _token, url) => {
        added.push(url);
        return Promise.resolve();
      },
    });
    await live.test();
    expect(added).toEqual(['http://127.0.0.1:50123/v1/health']);
    const away = new DownloadsService({
      secrets: { get: () => Promise.resolve('t') },
      connection: { get: () => Promise.resolve({ kind: 'app-not-running' } as const) },
      log: silentLog,
    });
    await expect(away.test()).rejects.toThrow('DLM is not connected.');
  });
});
