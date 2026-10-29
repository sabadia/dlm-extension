import { listen, type RuntimeLike } from '../lib/bus/bus';
import { createHandlers } from './handlers';
import { createServices, type Environment } from './services';

/**
 * The one place where the background registers its listeners. It runs synchronously while the background script loads
 * (a service worker or event page that is woken by an event only delivers it to listeners registered by the end of the
 * first turn), and every listener reads what it needs from storage when it runs. New listeners (downloads, web requests,
 * alarms, context menus…) are added here, never inside a callback or after an `await`.
 */
export function registerBackground(
  runtime: RuntimeLike,
  env: Environment,
  lifecycle: Lifecycle,
): void {
  const services = createServices(env);
  listen(runtime, createHandlers(services), (type, error) => {
    services.log.warn('bus', `handler ${type} failed`, { error });
  });

  const check = (why: string) => {
    services.log.debug('connection', `check: ${why}`);
    void services.connection.refresh();
  };
  lifecycle.onStartup.addListener(() => check('startup'));
  lifecycle.onInstalled.addListener(() => {
    ensureAlarm(lifecycle.alarms);
    check('installed');
  });
  lifecycle.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CHECK_ALARM) check('alarm');
  });
  // Alarms can be lost with the browser session: make sure ours exists whenever the background loads.
  ensureAlarm(lifecycle.alarms);
}

/** The alarm that looks at the connection once a minute. */
export const CHECK_ALARM = 'connection-check';

/** The parts of `browser.runtime` and `browser.alarms` the background lifecycle uses. */
export interface Lifecycle {
  onStartup: { addListener(listener: () => void): void };
  onInstalled: { addListener(listener: () => void): void };
  alarms: {
    get(name: string): Promise<unknown>;
    create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
    onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
  };
}

function ensureAlarm(alarms: Lifecycle['alarms']): void {
  void Promise.resolve(alarms.get(CHECK_ALARM)).then(async (existing) => {
    if (!existing) await alarms.create(CHECK_ALARM, { periodInMinutes: 1 });
  });
}
