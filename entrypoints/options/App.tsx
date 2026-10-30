import { useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import { t } from '../../src/lib/i18n';
import { RemoteTargets } from '../../src/ui/RemoteTargets';
import { Button, Card } from '../../src/ui/kit';
import { Onboarding } from './Onboarding';
import { backgroundOnboarding } from './onboarding-api';
import { RulesForm } from './RulesForm';
import { backgroundSettings } from './settings-api';

type CopyState = { kind: 'idle' } | { kind: 'copied' } | { kind: 'failed'; reason: string };

const SECTIONS = [
  ['start', 'options.nav.start'],
  ['servers', 'options.nav.servers'],
  ['files', 'options.nav.files'],
  ['rules', 'options.nav.rules'],
  ['routes', 'options.nav.routes'],
  ['advanced', 'options.nav.advanced'],
] as const;

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
    <div class="shell">
      <aside class="side">
        <div class="brand">
          <img src="/icon-32.png" alt="" width="28" height="28" />
          <strong>DLM</strong>
        </div>
        <nav aria-label={t('options.nav.label')}>
          {SECTIONS.map(([id, key]) => (
            <a key={id} href={`#${id}`}>
              {t(key)}
            </a>
          ))}
        </nav>
      </aside>
      <main class="content">
        <header class="intro">
          <h1>{t('options.title')}</h1>
          <p class="muted">{t('options.subtitle')}</p>
        </header>
        <Onboarding api={backgroundOnboarding} />
        <RemoteTargets />
        <RulesForm api={backgroundSettings} />
        <Card
          id="diagnostics"
          title={t('options.diagnostics.title')}
          description={t('options.diagnostics.help')}
        >
          <div>
            <Button icon="copy" onClick={() => void copyDiagnostics()}>
              {t('options.diagnostics.copy')}
            </Button>
          </div>
          <p role="status" aria-live="polite">
            {copy.kind === 'copied' && t('options.diagnostics.copied')}
            {copy.kind === 'failed' && t('options.diagnostics.failed', { reason: copy.reason })}
          </p>
        </Card>
      </main>
    </div>
  );
}
