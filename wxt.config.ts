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
    description: 'Send downloads, media, magnet links and torrents from your browser to DLM.',
    // The permission set grows with the features (docs/PLAN.md, "Permissions"); each addition is a plan change.
    permissions: ['storage'],
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
