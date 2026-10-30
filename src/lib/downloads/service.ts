import { DlmClient } from '../api/client';
import type { ConnectionService } from '../connection/service';
import { t } from '../i18n';
import type { Logger } from '../log/log';
import type { SecretStore } from '../settings/store';

export interface DownloadsDeps {
  secrets: Pick<SecretStore, 'get'>;
  connection: Pick<ConnectionService, 'get'>;
  log: Logger;
  /** Adds an address. Tests pass a fake. */
  add?: (baseUrl: string, token: string, url: string) => Promise<void>;
}

/** The one thing the extension still asks of the downloads: a test that the whole way to DLM works. */
export class DownloadsService {
  constructor(private readonly deps: DownloadsDeps) {}

  /**
   * A test download: DLM fetches its own health report. It is a real file from a real address that DLM can reach from
   * where it runs (a made-up address never resolves), it needs no login, and it is small.
   */
  async test(): Promise<void> {
    const state = await this.deps.connection.get();
    if (state.kind !== 'connected') throw new Error(t('links.offline'));
    const token = await this.deps.secrets.get(state.targetId);
    if (!token) throw new Error(t('links.offline'));
    const add =
      this.deps.add ??
      (async (baseUrl, secret, url) => {
        await new DlmClient({ baseUrl, token: secret }).createTask({ url });
      });
    await add(state.baseUrl, token, `${state.baseUrl}/v1/health`);
  }
}
