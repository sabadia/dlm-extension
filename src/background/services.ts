import { ConnectionService, type ActionApi } from '../lib/connection/service';
import { DlmClient } from '../lib/api/client';
import {
  InterceptService,
  type CookiesPort,
  type DownloadsPort,
  type NotificationsPort,
  type WindowsPort,
} from '../lib/intercept/service';
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
  };
}
