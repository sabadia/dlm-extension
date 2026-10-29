import { listen, type RuntimeLike } from '../lib/bus/bus';
import { createHandlers } from './handlers';
import { createServices, type Environment } from './services';

/**
 * The one place where the background registers its listeners. It runs synchronously while the background script loads
 * (a service worker or event page that is woken by an event only delivers it to listeners registered by the end of the
 * first turn), and every listener reads what it needs from storage when it runs. New listeners (downloads, web requests,
 * alarms, context menus…) are added here, never inside a callback or after an `await`.
 */
export function registerBackground(runtime: RuntimeLike, env: Environment): void {
  const services = createServices(env);
  listen(runtime, createHandlers(services), (type, error) => {
    services.log.warn('bus', `handler ${type} failed`, { error });
  });
}
