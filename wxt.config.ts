import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

/** The Firefox add-on id. It never changes: native messaging and the daemon's allow-list refer to it. */
const FIREFOX_ID = 'dlm-extension@sabadia.github.io';

/**
 * The public half of the Chrome extension key. It fixes the extension id for every Chromium browser
 * (`gfjgahdobbldpjiijaakihgmmjemdalg`), which the native-messaging host manifest and the daemon refer to. The private half lives
 * in the repository secret CHROME_EXTENSION_KEY_PEM and in the maintainer's backup; it is only needed
 * to publish to a store with the same id.
 */
const CHROME_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArr6mGiHVmXdOaAnGM6I+lMOdpL/KhG7TsxmSpcw3Lp9N3wRihhgk5i7VyUr0p75xfLoX54Jdk6ZlRq28XcL25RxYTGWbWiOKQlLRsNzRIOjaDNWvk7e/N8DmcUc14+/YfX8ipqbbsfkXZ1iokW8NAiXMtNe5Z29BIKndjDdkOn3jjwMLhhB1H5PWrFkufoh3SvS/oAxGl+Shc7f/ge90XDVjojHBMNQw69ikfYeJNF0ESddLpj91vvCQB2hrjdAllWQq1lGATroRbBdZxPjGpilsF5zIwJ9o7Pg1lAqXxR5RRCf3HJrVpV5kpAp3lk1XXo6ZaTn04GlK80MeZheiPwIDAQAB';

export default defineConfig({
  srcDir: '.',
  manifestVersion: 3,
  vite: () => ({ plugins: [preact()] }),
  manifest: ({ browser }) => ({
    name: 'DLM',
    // Manifest strings come from public/_locales/<language>/messages.json (the browser translates them); the pages
    // use the catalogue in src/lib/i18n.
    default_locale: 'en',
    description: '__MSG_extDescription__',
    // The permission set grows with the features (docs/PLAN.md, "Permissions"). E2 adds downloads, webRequest,
    // cookies and notifications, and host access to every site so a download's headers and cookies can be read.
    // Firefox also gets webRequestBlocking so an attachment can be cancelled before a download entry appears.
    permissions: [
      'storage',
      'nativeMessaging',
      'alarms',
      'downloads',
      'webRequest',
      'cookies',
      'notifications',
      'contextMenus',
      ...(browser === 'firefox' ? ['webRequestBlocking' as const] : []),
    ],
    icons: { '16': '/icon-16.png', '128': '/icon.png' },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+D' },
        description: '__MSG_cmdOpen__',
      },
      'toggle-intercept': {
        suggested_key: { default: 'Alt+Shift+I' },
        description: '__MSG_cmdToggleIntercept__',
      },
      'open-options': {
        suggested_key: { default: 'Alt+Shift+O' },
        description: '__MSG_cmdOpenOptions__',
      },
    },
    // The daemon of this computer, plus every site a download can come from. Remote servers are still asked for one
    // by one on Firefox, where host access is not granted at install (onboarding asks for it).
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*', 'http://*/*', 'https://*/*'],
    ...(browser === 'firefox' ? {} : { key: CHROME_PUBLIC_KEY }),
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: FIREFOX_ID,
              strict_min_version: '140.0',
              // We collect nothing; Firefox requires the declaration for new add-ons.
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
});
