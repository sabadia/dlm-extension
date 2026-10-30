import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { sendMessage } from '../lib/bus/bus';
import { t } from '../lib/i18n';
import type { PairingView } from '../lib/pairing/service';

/** How often a pending pairing is checked, in milliseconds. */
const POLL_MS = 2000;

/**
 * Pairs this browser with the DLM on this computer: shows the code to compare while the person answers in the DLM app.
 * The work is in the background (`pairing.*` messages); the panel only asks again every couple of seconds while it is
 * open, and shows where things stand. It holds no secret.
 */
export function PairingPanel(props: { onPaired?: () => void }) {
  const [view, setView] = useState<PairingView>({ phase: 'idle' });

  useEffect(() => {
    void sendMessage(browser.runtime, 'pairing.view').then(setView, () => undefined);
  }, []);

  useEffect(() => {
    if (view.phase !== 'pending') return undefined;
    const timer = setInterval(() => {
      void sendMessage(browser.runtime, 'pairing.poll').then(setView, () => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [view.phase]);

  useEffect(() => {
    if (view.phase === 'approved') props.onPaired?.();
  }, [view.phase]);

  const ask = (type: 'pairing.start' | 'pairing.cancel') => {
    void sendMessage(browser.runtime, type).then(setView, (e: unknown) =>
      setView({ phase: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
  };

  return (
    <section class="inset stack" aria-labelledby="pairing-title">
      <h3 id="pairing-title">{t('pairing.title')}</h3>
      {view.phase === 'idle' && <p>{t('pairing.intro')}</p>}
      {view.phase === 'pending' && (
        <div>
          <p>{t('pairing.code')}</p>
          <p aria-label={view.code} class="pair-code">
            {view.code.length === 6 ? `${view.code.slice(0, 3)} ${view.code.slice(3)}` : view.code}
          </p>
          <p role="status">{t('pairing.waiting')}</p>
        </div>
      )}
      <p role="status" aria-live="polite">
        {view.phase === 'approved' && t('pairing.approved')}
        {view.phase === 'denied' && t('pairing.denied')}
        {view.phase === 'expired' && t('pairing.expired')}
        {view.phase === 'error' && t('pairing.error', { message: view.message })}
      </p>
      {view.phase === 'pending' ? (
        <button type="button" class="btn" onClick={() => ask('pairing.cancel')}>
          {t('pairing.cancel')}
        </button>
      ) : (
        view.phase !== 'approved' && (
          <button type="button" class="btn primary" onClick={() => ask('pairing.start')}>
            {t('pairing.start')}
          </button>
        )
      )}
    </section>
  );
}
