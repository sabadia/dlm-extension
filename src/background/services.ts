import { ConnectionService, type ActionApi } from '../lib/connection/service';
import { DlmClient } from '../lib/api/client';
import {
  InterceptService,
  type CookiesPort,
  type DownloadsPort,
  type NotificationsPort,
  type WindowsPort,
} from '../lib/intercept/service';
import { LinksService, type MenuPort, type TaskPort } from '../lib/links/service';
import { MediaService } from '../lib/media/service';
import { RingLog } from '../lib/log/log';
import { RemoteService } from '../lib/remote/service';
import { NativeHost, type NativeRuntime } from '../lib/native/host';
import { detectBrowser } from '../lib/pairing/browser';
import { PairingService } from '../lib/pairing/service';
import { SecretStore, SettingsStore } from '../lib/settings/store';
import type { KeyValueArea } from '../lib/storage/area';

/** What the background needs from the browser, so that it can be built and tested without one. */
export interface Environment {
  /** `storage.local`: settings and tokens. Never `sync`. */
  local: KeyValueArea;
  /** `storage.session`: the log and state that may be lost with the browser session. */
  session: KeyValueArea;
  /** The extension's version from the manifest. */
  version: string;
  userAgent: string;
  /** `navigator.brave` exists (Brave hides itself in the user agent). */
  brave?: boolean;
  /** `browser.runtime`, for the native host. */
  native: NativeRuntime;
  /** `browser.action`, for the badge. */
  action: ActionApi;
  /** Whether the browser lets the extension call an address (`permissions.contains`); yes when omitted. */
  hasAccess?: (baseUrl: string) => Promise<boolean>;
  /** This extension's id. Needed to recognise downloads it started itself. */
  extensionId?: string;
  /** `chrome-extension://<id>` or `moz-extension://<internal UUID>`. */
  extensionOrigin?: string;
  /** Firefox cancels an attachment before a download entry exists. */
  firefox?: boolean;
  /** Shown on a notification. */
  iconUrl?: string;
  downloads?: DownloadsPort;
  cookies?: CookiesPort;
  notifications?: NotificationsPort;
  windows?: WindowsPort;
  /** Address of the small ask window, including the pending id. */
  askUrl?: (id: string) => string;
  /** Context menus (E3). */
  menus?: MenuPort;
  /** Address of the "all links" preview for one tab. */
  linksUrl?: (tabId: number) => string;
  /** Reads a cookie-gated `.torrent` file. */
  fetchFile?: (url: string) => Promise<Uint8Array>;
  /** Reads a playlist for the quality picker. */
  fetchText?: (url: string) => Promise<string>;
}

/**
 * The background's collaborators. They hold no state of their own beyond what a restarted worker can read back from
 * storage, so building them again after a restart is harmless (and there are no module-level singletons).
 */
export interface Services {
  log: RingLog;
  settings: SettingsStore;
  secrets: SecretStore;
  version: string;
  userAgent: string;
  host: NativeHost;
  pairing: PairingService;
  connection: ConnectionService;
  remote: RemoteService;
  /** Present once the download, cookie, notification and window ports are wired (E2). */
  intercept?: InterceptService;
  /** Context menus, direct links and batches (E3). */
  links?: LinksService;
  /** Per-tab media list (E4). */
  media?: MediaService;
}

export function createServices(env: Environment): Services {
  const log = new RingLog(env.session);
  const secrets = new SecretStore(env.local);
  const host = new NativeHost(env.native, { log });
  const settings = new SettingsStore(env.local);
  const pairing = new PairingService({
    host,
    secrets,
    area: env.session,
    browser: detectBrowser(env.userAgent, env.brave ?? false),
    version: env.version,
    log,
  });
  const connection = new ConnectionService({
    settings,
    secrets,
    host,
    pairing,
    area: env.session,
    action: env.action,
    log,
    ...(env.hasAccess ? { hasAccess: env.hasAccess } : {}),
  });
  const remote = new RemoteService({
    settings,
    secrets,
    client: (baseUrl, token) => new DlmClient({ baseUrl, token, log }),
    log,
    changed: () => void connection.refresh(),
  });
  const taskPort = (baseUrl: string, token: string): TaskPort => {
    const client = new DlmClient({ baseUrl, token, log });
    return {
      listQueues: () => client.listQueues(),
      create: (body) => client.createTask(body),
      createMany: async (items) => {
        const result = await client.createTasks({ items });
        return (result.results ?? []).map((item) => ({ ok: item.ok }));
      },
      addTorrent: (bytes, query) => client.addTorrentFile(bytes, query),
    };
  };
  const media = new MediaService({
    secrets,
    connection,
    session: env.session,
    log,
    tasks: (baseUrl, token) => {
      const client = new DlmClient({ baseUrl, token, log });
      return {
        create: (body) => client.createTask(body),
        resolve: async (url) => {
          const result = await client.resolve({ url });
          return {
            name: result.name,
            size: result.resource.size,
            ...(result.duplicateOf ? { duplicate: result.duplicateOf.name } : {}),
          };
        },
      };
    },
    ...(env.fetchText ? { fetchText: env.fetchText } : {}),
  });
  const links =
    env.menus && env.linksUrl
      ? new LinksService({
          settings,
          secrets,
          connection,
          session: env.session,
          log,
          menus: env.menus,
          tasks: taskPort,
          linksUrl: env.linksUrl,
          ...(env.fetchFile ? { fetchFile: env.fetchFile } : {}),
        })
      : undefined;
  const intercept =
    env.downloads && env.cookies && env.notifications && env.windows && env.askUrl
      ? new InterceptService({
          settings,
          secrets,
          connection,
          session: env.session,
          log,
          extensionId: env.extensionId ?? '',
          extensionOrigin: env.extensionOrigin ?? '',
          userAgent: env.userAgent,
          firefox: env.firefox ?? false,
          ...(env.iconUrl ? { iconUrl: env.iconUrl } : {}),
          downloads: env.downloads,
          cookies: env.cookies,
          notifications: env.notifications,
          windows: env.windows,
          askUrl: env.askUrl,
          client: (baseUrl, token) => new DlmClient({ baseUrl, token, log }),
          ...(links ? { torrents: links } : {}),
        })
      : undefined;
  return {
    log,
    settings,
    secrets,
    version: env.version,
    userAgent: env.userAgent,
    host,
    pairing,
    connection,
    remote,
    ...(intercept ? { intercept } : {}),
    ...(links ? { links } : {}),
    media,
  };
}
