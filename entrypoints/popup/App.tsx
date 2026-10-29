import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import type { ConnectionState } from '../../src/lib/connection/state';
import { t } from '../../src/lib/i18n';
import { PRODUCT_NAME } from '../../src/lib/product';
import { PairingPanel } from '../../src/ui/PairingPanel';

interface Shown {
  state: ConnectionState;
  text: string;
}

/** The states in which the person can fix things by pairing. */
const PAIRABLE = new Set<ConnectionState['kind']>(['needs-pairing', 'pairing', 'token-revoked']);

export function App() {
  const [shown, setShown] = useState<Shown>({
    state: { kind: 'checking' },
    text: t('state.checking'),
  });

  const refresh = () => {
    void sendMessage(browser.runtime, 'connection.refresh').then(setShown, () => undefined);
  };

  /** Asks the browser for access to the server. It must run in the click that asks (a user gesture). */
  const allow = (state: ConnectionState) => {
    if (state.kind !== 'access-needed') return;
    void browser.permissions.request({ origins: [state.origin] }).then(refresh, refresh);
  };

  useEffect(() => {
    // What the background knows is shown at once; then it looks again.
    void sendMessage(browser.runtime, 'connection.get').then(setShown, () => undefined);
    refresh();
  }, []);

  return (
    <main>
      <h1>{PRODUCT_NAME}</h1>
      <p role="status" aria-live="polite">
        {shown.text}
      </p>
      {shown.state.kind === 'access-needed' && (
        <button type="button" onClick={() => allow(shown.state)}>
          {t('state.accessAllow')}
        </button>
      )}
      {PAIRABLE.has(shown.state.kind) && <PairingPanel onPaired={refresh} />}
    </main>
  );
}
