import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import type { OnboardingApi } from './Onboarding';

/** Every site the extension hands downloads from: what Firefox asks for at setup. */
const ALL_SITES = ['http://*/*', 'https://*/*'];

export const backgroundOnboarding: OnboardingApi = {
  connection: async () => (await sendMessage(browser.runtime, 'connection.get')).state.kind,
  refresh: async () => (await sendMessage(browser.runtime, 'connection.refresh')).state.kind,
  hasSiteAccess: () => browser.permissions.contains({ origins: ALL_SITES }),
  requestSiteAccess: () => browser.permissions.request({ origins: ALL_SITES }),
  sendTest: () => sendMessage(browser.runtime, 'downloads.test'),
};
