import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

/** The Firefox add-on id. It never changes: native messaging and the daemon's allow-list refer to it. */
const FIREFOX_ID = 'dlm-extension@sabadia.github.io';

export default defineConfig({
  srcDir: '.',
  manifestVersion: 3,
  vite: () => ({ plugins: [preact()] }),
  manifest: ({ browser }) => ({
    name: 'DLM',
    description: 'Send downloads, media, magnet links and torrents from your browser to DLM.',
    // The permission set grows with the features (docs/PLAN.md, "Permissions"); each addition is a plan change.
    permissions: ['storage'],
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
