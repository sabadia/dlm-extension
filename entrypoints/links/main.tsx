import { render } from 'preact';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import type { PageLink } from '../../src/lib/links/filter';
import { App } from './App';

const root = document.getElementById('app');
const tabId = Number(new URLSearchParams(location.search).get('tab'));
const links: PageLink[] =
  Number.isInteger(tabId) && tabId > 0
    ? await browser.tabs
        .sendMessage(tabId, { type: 'links.collect' })
        .then((value) => (Array.isArray(value) ? (value as PageLink[]) : []))
        .catch(() => [])
    : [];

if (root) {
  render(
    <App
      links={links}
      onSend={(urls) => sendMessage(browser.runtime, 'links.send', { urls })}
      onProbe={(urls) => sendMessage(browser.runtime, 'media.probe', { urls })}
    />,
    root,
  );
}
