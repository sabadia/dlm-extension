import { render } from 'preact';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import type { AskChoice } from '../../src/lib/intercept/service';
import { App } from './App';

const root = document.getElementById('app');
const id = new URLSearchParams(location.search).get('id') ?? '';

async function choose(choice: AskChoice): Promise<void> {
  try {
    await sendMessage(browser.runtime, 'ask.choose', { id, choice });
  } finally {
    // Whatever happened, the prompt is over; closing it must not depend on the background answering.
    window.close();
  }
}

const view = id ? await sendMessage(browser.runtime, 'ask.get', { id }).catch(() => null) : null;
if (root) {
  render(
    <App
      name={view?.name ?? ''}
      host={view?.host ?? ''}
      purpose={view?.purpose ?? 'ask'}
      checksum={view?.checksum}
      onChoose={(choice) => {
        void choose(choice).catch(() => undefined);
      }}
    />,
    root,
  );
}
