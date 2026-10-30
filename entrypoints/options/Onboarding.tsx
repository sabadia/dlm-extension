import { useEffect, useState } from 'preact/hooks';
import type { ConnectionState } from '../../src/lib/connection/state';
import { setupSteps, type SetupStep } from '../../src/lib/downloads/setup';
import { t, type MessageKey } from '../../src/lib/i18n';
import { PairingPanel } from '../../src/ui/PairingPanel';

/** What the setup needs from the background and the browser; a test passes a fake. */
export interface OnboardingApi {
  connection(): Promise<ConnectionState['kind']>;
  /** Looks at DLM again and says what it found. */
  refresh(): Promise<ConnectionState['kind']>;
  hasSiteAccess(): Promise<boolean>;
  /** Asks the browser for access to every site. Must run in the click of the person. */
  requestSiteAccess(): Promise<boolean>;
  sendTest(): Promise<{ ok: boolean; error?: string }>;
}

const STEP_TEXT: Record<SetupStep, MessageKey> = {
  app: 'onboarding.app',
  host: 'onboarding.host',
  pair: 'onboarding.pair',
  access: 'onboarding.access',
  test: 'onboarding.test',
};

const APP_RELEASES = 'https://github.com/sabadia/dlm-app/releases/latest';

/** How often the steps are checked again while setup is not finished. */
const CHECK_MS = 3000;

/**
 * The setup, step by step: install the app, register the browser, pair, allow access, send a test download. Each step
 * shows whether it is done, the next one has what it needs (a link, the pairing code, the permission button), and the
 * page checks again by itself, so a step finished in the app is seen without a reload.
 */
export function Onboarding({ api }: { api: OnboardingApi }) {
  const [kind, setKind] = useState<ConnectionState['kind']>('checking');
  const [siteAccess, setSiteAccess] = useState(true);
  const [note, setNote] = useState('');

  const check = () => {
    api.refresh().then(setKind, () => undefined);
    api.hasSiteAccess().then(setSiteAccess, () => undefined);
  };

  useEffect(() => {
    api.connection().then(setKind, () => undefined);
    check();
  }, []);

  useEffect(() => {
    if (kind === 'connected' && siteAccess) return undefined;
    const timer = setInterval(check, CHECK_MS);
    return () => clearInterval(timer);
  }, [kind, siteAccess]);

  const steps = setupSteps(kind, siteAccess);
  const pairable = kind === 'needs-pairing' || kind === 'pairing' || kind === 'token-revoked';
  return (
    <section aria-labelledby="setup-title">
      <h2 id="setup-title">{t('onboarding.title')}</h2>
      <ol>
        {steps.map((step) => (
          <li key={step.id}>
            <span aria-hidden="true">{step.done ? '✓ ' : ''}</span>
            <span class="visually-hidden">
              {step.done ? t('onboarding.stepDone') : t('onboarding.stepTodo')}{' '}
            </span>
            {t(STEP_TEXT[step.id])}
            {step.id === 'app' && !step.done ? (
              <>
                {' '}
                <a href={APP_RELEASES} target="_blank" rel="noreferrer">
                  {t('onboarding.appLink')}
                </a>
              </>
            ) : null}
            {step.id === 'host' && !step.done ? <p>{t('onboarding.hostMac')}</p> : null}
            {step.id === 'access' && !siteAccess ? (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => {
                    api.requestSiteAccess().then(
                      () => check(),
                      () => check(),
                    );
                  }}
                >
                  {t('onboarding.accessAllow')}
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ol>
      {pairable ? <PairingPanel onPaired={check} /> : null}
      {kind === 'connected' ? (
        <p>
          <button
            type="button"
            onClick={() => {
              setNote('');
              api.sendTest().then(
                (result) =>
                  setNote(
                    result.ok
                      ? t('onboarding.done')
                      : (result.error ?? t('intercept.reason.rejected')),
                  ),
                (error: unknown) =>
                  setNote(error instanceof Error ? error.message : t('error.failed')),
              );
            }}
          >
            {t('onboarding.testSend')}
          </button>
        </p>
      ) : null}
      <p role="status" aria-live="polite">
        {note}
      </p>
    </section>
  );
}
