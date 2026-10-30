import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { sendMessage } from '../lib/bus/bus';
import { t } from '../lib/i18n';
import { warningsFor, type RemoteTestResult, type RemoteView } from '../lib/remote/service';
import { Badge, Button, Card } from './kit';
import { normalizeBaseUrl, originPattern } from '../lib/settings/url';

/** The sentence for a failed test. */
function problemText(r: Exclude<RemoteTestResult, { ok: true }>): string {
  switch (r.problem) {
    case 'invalid-url':
      return t(`remote.invalid.${r.detail}`);
    case 'unauthorized':
      return t('remote.unauthorized');
    case 'unreachable':
      return t('remote.unreachable', { message: r.message });
    case 'incompatible':
      return r.compatibility.reason === 'daemon-too-old'
        ? t('state.daemonTooOld', { minVersion: r.compatibility.minVersion })
        : t('state.extensionTooOld');
    case 'failed':
      return t('remote.failed', { message: r.message });
  }
}

/**
 * Lists the servers and adds, tests and removes them. Access to a server's address is asked from the browser here, in
 * the click of the person (a permission can only be requested from a user gesture); the background then tests the server
 * and saves it. The token is typed here, sent to the background and never shown again.
 */
export function RemoteTargets() {
  const [targets, setTargets] = useState<RemoteView[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [note, setNote] = useState('');

  const load = () =>
    void sendMessage(browser.runtime, 'remote.list').then(setTargets, () => undefined);
  useEffect(load, []);

  const normalized = normalizeBaseUrl(url);
  const plainHttp = normalized.ok && warningsFor(normalized.url).includes('plain-http');

  async function ask(): Promise<boolean> {
    if (!normalized.ok) return true; // the background explains what is wrong with the address
    return browser.permissions.request({ origins: [originPattern(normalized.url)] });
  }

  async function test() {
    if (!(await ask())) return setNote(t('remote.accessDenied'));
    const r = await sendMessage(browser.runtime, 'remote.test', { url, token });
    setNote(r.ok ? t('remote.ok', { version: r.version }) : problemText(r));
  }

  async function add() {
    if (!(await ask())) return setNote(t('remote.accessDenied'));
    const r = await sendMessage(browser.runtime, 'remote.add', { name, url, token });
    if (r.ok) {
      setName('');
      setUrl('');
      setToken('');
      setNote(t('remote.added'));
      load();
    } else {
      setNote(problemText(r));
    }
  }

  async function remove(target: RemoteView) {
    await sendMessage(browser.runtime, 'remote.remove', { id: target.id });
    // Give the access back unless another server on the same host still needs it.
    if (target.url) {
      const pattern = originPattern(target.url);
      const others = targets.filter(
        (x) => x.id !== target.id && x.url && originPattern(x.url) === pattern,
      );
      if (others.length === 0)
        void browser.permissions.remove({ origins: [pattern] }).catch(() => undefined);
    }
    load();
  }

  return (
    <Card id="servers" title={t('remote.title')} description={t('remote.help')}>
      <ul class="targets">
        {targets.map((target) => (
          <li key={target.id} class="target">
            <div class="grow">
              <strong>{target.kind === 'local' ? t('remote.local') : target.name}</strong>
              {target.url && <div class="small muted truncate">{target.url}</div>}
              {target.kind === 'remote' && !target.hasToken && (
                <div class="small">
                  <Badge tone="warning">{t('remote.noToken')}</Badge>
                </div>
              )}
            </div>
            {target.active ? (
              <Badge tone="success">{t('remote.active')}</Badge>
            ) : (
              <Button
                size="small"
                onClick={() =>
                  void sendMessage(browser.runtime, 'remote.setActive', { id: target.id }).then(
                    load,
                  )
                }
              >
                {t('remote.makeActive')}
              </Button>
            )}
            {target.kind === 'remote' && (
              <Button variant="ghost" size="small" onClick={() => void remove(target)}>
                {t('remote.remove')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <hr class="divider" />
      <form class="stack" onSubmit={(e) => e.preventDefault()}>
        <label class="field">
          <span class="label">{t('remote.name')}</span>
          <input
            class="input"
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
            autocomplete="off"
          />
        </label>
        <label class="field">
          <span class="label">{t('remote.url')}</span>
          <input
            class="input"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
            placeholder={t('remote.urlHint')}
            inputMode="url"
            autocomplete="off"
          />
        </label>
        <label class="field">
          <span class="label">{t('remote.token')}</span>
          <input
            class="input"
            type="password"
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
            autocomplete="off"
          />
        </label>
        {plainHttp && (
          <p class="error" role="alert">
            {t('remote.warnPlainHttp')}
          </p>
        )}
        {normalized.ok && normalized.url.startsWith('https:') && (
          <p class="help">{t('remote.selfSigned')}</p>
        )}
        <div class="row">
          <Button onClick={() => void test()}>{t('remote.test')}</Button>
          <Button variant="primary" type="submit" onClick={() => void add()}>
            {t('remote.add')}
          </Button>
        </div>
        <p role="status" aria-live="polite">
          {note}
        </p>
      </form>
    </Card>
  );
}
