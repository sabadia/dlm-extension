import { useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import { t } from '../../src/lib/i18n';
import { RemoteTargets } from '../../src/ui/RemoteTargets';
import { Onboarding } from './Onboarding';
import { backgroundOnboarding } from './onboarding-api';
import { RulesForm } from './RulesForm';
import { backgroundSettings } from './settings-api';

type CopyState = { kind: 'idle' } | { kind: 'copied' } | { kind: 'failed'; reason: string };

export function App() {
  const [copy, setCopy] = useState<CopyState>({ kind: 'idle' });

  async function copyDiagnostics() {
    try {
      const text = await sendMessage(browser.runtime, 'diagnostics.get');
      await navigator.clipboard.writeText(text);
      setCopy({ kind: 'copied' });
    } catch (e) {
      setCopy({ kind: 'failed', reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <main>
      <h1>{t('options.title')}</h1>
      <Onboarding api={backgroundOnboarding} />
      <RemoteTargets />
      <RulesForm api={backgroundSettings} />
      <section aria-labelledby="diagnostics-title">
        <h2 id="diagnostics-title">{t('options.diagnostics.title')}</h2>
        <p>{t('options.diagnostics.help')}</p>
        <button type="button" onClick={() => void copyDiagnostics()}>
          {t('options.diagnostics.copy')}
        </button>
        <p role="status" aria-live="polite">
          {copy.kind === 'copied' && t('options.diagnostics.copied')}
          {copy.kind === 'failed' && t('options.diagnostics.failed', { reason: copy.reason })}
        </p>
      </section>
    </main>
  );
}
