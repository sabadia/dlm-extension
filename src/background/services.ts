import { ConnectionService, type ActionApi } from '../lib/connection/service';
import { DlmClient } from '../lib/api/client';
import { t } from '../lib/i18n';
import { DownloadsService } from '../lib/downloads/service';
import {
  InterceptService,
  type CookiesPort,
  type DownloadsPort,
  type NotificationsPort,
  type WindowsPort,
} from '../lib/intercept/service';
import { LinksService, type MenuPort, type TaskPort } from '../lib/links/service';
import { MediaService } from '../lib/media/service';
import { RefreshService } from '../lib/refresh/service';
import { RingLog } from '../lib/log/log';
import { RemoteService } from '../lib/remote/service';
import { NativeHost, type NativeRuntime } from '../lib/native/host';
import { detectBrowser } from '../lib/pairing/browser';
import { HintStore } from '../lib/page/store';
import { PairingService } from '../lib/pairing/service';
import { SecretStore, SettingsStore } from '../lib/settings/store';
import type { KeyValueArea } from '../lib/storage/area';
import type { Surface } from '../lib/settings/schema';
import { applySurface, type SurfaceApi } from './surface';

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
  /** Where the toolbar button opens the files. Absent in tests. */
  surface?: SurfaceApi;
  /** Opens a page, for an expired link. */
  open?: (url: string) => Promise<void>;
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
  /** The popup's live download list (E5). */
  downloads: DownloadsService;
  /** Expired links the daemon is waiting for this browser to capture again (E6.1). */
  refresh: RefreshService;
  /** Puts the toolbar button on the surface the settings choose. Absent where there is no such button (tests). */
  applySurface?: (surface: Surface) => Promise<void>;
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
  const hints = new HintStore(env.session);
  const taskPort = (baseUrl: string, token: string): TaskPort => {
    const client = new DlmClient({ baseUrl, token, log });
    return {
      listQueues: () => client.listQueues(),
      create: (body) =>
        client.createTask(
          body.checksum || (body.mirrors && body.mirrors.length > 0)
            ? {
                source: {
                  currentUrl: body.url,
                  ...(body.mirrors && body.mirrors.length > 0 ? { mirrors: body.mirrors } : {}),
                },
                ...(body.checksum ? { settings: { checksum: body.checksum } } : {}),
                ...(body.queueId ? { queueId: body.queueId } : {}),
                ...(body.paused !== undefined ? { paused: body.paused } : {}),
                ...(body.name ? { name: body.name } : {}),
              }
            : body,
        ),
      createMany: async (items) => {
        const result = await client.createTasks({ items });
        return (result.results ?? []).map((item) => ({ ok: item.ok }));
      },
      addTorrent: (bytes, query) => client.addTorrentFile(bytes, query),
    };
  };
  const media = new MediaService({
    secrets,
    settings,
    connection,
    session: env.session,
    log,
    userAgent: env.userAgent,
    tasks: (baseUrl, token) => {
      const client = new DlmClient({ baseUrl, token, log });
      return {
        capture: (body) => client.capture(body),
        listQueues: async () =>
          ((await client.listQueues()).queues ?? []).map((q) => ({ id: q.id, name: q.name })),
        importCookies: async (cookies) => {
          const result = await client.importCookies(cookies);
          return {
            imported: result.imported,
            skipped: result.skipped,
            rejected: result.errors?.length ?? 0,
          };
        },
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
    ...(env.cookies ? { cookies: env.cookies } : {}),
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
          notify: (message) => {
            void Promise.resolve(
              env.notifications?.create('dlm-links', {
                title: t('intercept.notify.title'),
                message,
                ...(env.iconUrl ? { iconUrl: env.iconUrl } : {}),
              }),
            ).catch(() => undefined);
          },
          ...(env.fetchFile ? { fetchFile: env.fetchFile } : {}),
        })
      : undefined;
  const refresh = new RefreshService({
    endpoints: () => connection.endpoints({ discover: false }),
    settings,
    notifications: env.notifications ?? { create: () => undefined },
    open: env.open ?? (() => Promise.resolve()),
    local: env.local,
    session: env.session,
    log,
    tasks: (baseUrl, token) => new DlmClient({ baseUrl, token, log }),
    ...(env.iconUrl ? { iconUrl: env.iconUrl } : {}),
  });
  const intercept =
    env.downloads && env.cookies && env.notifications && env.windows && env.askUrl
      ? new InterceptService({
          settings,
          secrets,
          connection,
          hints,
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
          refreshTarget: (pageUrl) => refresh.endpointFor(pageUrl),
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
    refresh,
    ...(intercept ? { intercept } : {}),
    ...(links ? { links } : {}),
    media,
    downloads: new DownloadsService({ secrets, connection, log }),
    ...(env.surface
      ? { applySurface: (surface: Surface) => applySurface(env.surface as SurfaceApi, surface) }
      : {}),
  };
}
