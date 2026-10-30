import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import { t } from '../../src/lib/i18n';
import type { SettingsApi } from './RulesForm';

/** The form's view of the background: the settings, and the targets a route may name. */
export const backgroundSettings: SettingsApi = {
  async load() {
    const [settings, targets] = await Promise.all([
      sendMessage(browser.runtime, 'settings.get'),
      sendMessage(browser.runtime, 'remote.list'),
    ]);
    return {
      settings,
      targets: targets.map((target) => ({
        id: target.id,
        name: target.kind === 'local' ? t('remote.local') : target.name,
      })),
    };
  },
  save: (patch) => sendMessage(browser.runtime, 'settings.save', patch),
  exportText: () => sendMessage(browser.runtime, 'settings.export'),
  importText: (text) => sendMessage(browser.runtime, 'settings.import', { text }),
};
