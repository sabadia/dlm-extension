import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import type { ConnectionState } from '../../src/lib/connection/state';
import { setupSteps } from '../../src/lib/downloads/setup';
import { t } from '../../src/lib/i18n';

const STEP_TEXT = {
  app: 'onboarding.app',
  host: 'onboarding.host',
  pair: 'onboarding.pair',
  access: 'onboarding.access',
  test: 'onboarding.test',
} as const;

/** The setup steps, plus a box that sends one address when DLM is connected. */
export function Onboarding() {
  const [kind, setKind] = useState<ConnectionState['kind']>('checking');
  const [url, setUrl] = useState('https://example.test/dlm-test.bin');
  const [note, setNote] = useState('');

  useEffect(() => {
    void sendMessage(browser.runtime, 'connection.get').then(
      (shown) => setKind(shown.state.kind),
      () => undefined,
    );
  }, []);

  const steps = setupSteps(kind).map((step) => ({
    ...step,
    text: t(STEP_TEXT[step.id as keyof typeof STEP_TEXT]),
  }));
  return (
    <section aria-labelledby="setup-title">
      <h2 id="setup-title">{t('onboarding.title')}</h2>
      <ol>
        {steps.map((step) => (
          <li key={step.id}>
            <span>{step.done ? '✓ ' : ''}</span>
            {step.text}
          </li>
        ))}
      </ol>
      {kind === 'connected' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage(browser.runtime, 'downloads.test', { url }).then(
              (result) => {
                setNote(
                  result.ok
                    ? t('onboarding.done')
                    : (result.error ?? t('intercept.reason.rejected')),
                );
              },
              () => undefined,
            );
          }}
        >
          <label>
            {t('onboarding.test')}
            <input value={url} onInput={(event) => setUrl(event.currentTarget.value)} />
          </label>
          <button type="submit">{t('onboarding.testSend')}</button>
        </form>
      ) : null}
      <p role="status">{note}</p>
    </section>
  );
}
