import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import type { ConnectionState } from '../../src/lib/connection/state';
import { t } from '../../src/lib/i18n';
import { PRODUCT_NAME } from '../../src/lib/product';
import type { MediaKind } from '../../src/lib/media/classify';
import type { Variant } from '../../src/lib/media/playlist';
import type { TabView } from '../../src/lib/media/service';
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
      <MediaList />
      {shown.state.kind === 'access-needed' && (
        <button type="button" onClick={() => allow(shown.state)}>
          {t('state.accessAllow')}
        </button>
      )}
      {PAIRABLE.has(shown.state.kind) && <PairingPanel onPaired={refresh} />}
    </main>
  );
}

const KIND_KEY: Record<
  MediaKind,
  'media.kind.hls' | 'media.kind.dash' | 'media.kind.video' | 'media.kind.audio' | 'media.kind.file'
> = {
  hls: 'media.kind.hls',
  dash: 'media.kind.dash',
  video: 'media.kind.video',
  audio: 'media.kind.audio',
  file: 'media.kind.file',
};

/** The media found on the tab that opened the popup, with one-click download and a quality picker. */
function MediaList() {
  const [view, setView] = useState<TabView>({
    items: [],
    protectedMedia: false,
    blobOrMse: false,
    pageUrl: '',
  });
  const [hints, setHints] = useState<
    Record<string, { name?: string; size?: number; duplicate?: string }>
  >({});
  const [variants, setVariants] = useState<Record<string, Variant[]>>({});
  const [note, setNote] = useState('');

  useEffect(() => {
    void browser.tabs.query({ active: true, currentWindow: true }).then(
      (tabs) => {
        const id = tabs[0]?.id;
        if (id === undefined) return;
        void sendMessage(browser.runtime, 'media.list', { tabId: id }).then(
          (listed) => {
            setView(listed);
            void sendMessage(browser.runtime, 'media.probe', {
              urls: listed.items.map((item) => item.url),
            }).then(
              (probed) => {
                const next: Record<string, { name?: string; size?: number; duplicate?: string }> =
                  {};
                for (const probe of probed) next[probe.url] = probe;
                setHints(next);
              },
              () => undefined,
            );
          },
          () => undefined,
        );
      },
      () => undefined,
    );
  }, []);

  const send = (
    url: string,
    extra: { quality?: string; kind?: MediaKind; resolverKind?: 'ytdlp' | 'browser' } = {},
  ) => {
    void sendMessage(browser.runtime, 'media.download', {
      url,
      pageUrl: view.pageUrl,
      ...extra,
    }).then(
      (result) => {
        setNote(result.ok ? t('media.sent') : (result.error ?? t('intercept.reason.rejected')));
      },
      () => undefined,
    );
  };

  return (
    <section>
      <h2>{t('media.title')}</h2>
      {view.protectedMedia ? <p>{t('media.protected')}</p> : null}
      {view.blobOrMse && !view.protectedMedia ? (
        <p>
          <button type="button" onClick={() => send(view.pageUrl, { resolverKind: 'ytdlp' })}>
            {t('media.pageYtdlp')}
          </button>{' '}
          <button type="button" onClick={() => send(view.pageUrl, { resolverKind: 'browser' })}>
            {t('media.pageBrowser')}
          </button>
        </p>
      ) : null}
      {view.items.length === 0 ? <p>{t('media.empty')}</p> : null}
      <ul>
        {view.items.map((item) => {
          const hint = hints[item.url];
          return (
            <li key={item.url}>
              <p>
                {hint?.name || item.name} · {t(KIND_KEY[item.kind])}
                {item.sizeBytes !== undefined || hint?.size !== undefined
                  ? ` · ${hint?.size ?? item.sizeBytes} B`
                  : ''}
              </p>
              {hint?.duplicate ? <p>{t('media.duplicate', { name: hint.duplicate })}</p> : null}
              <button type="button" onClick={() => send(item.url, { kind: item.kind })}>
                {t('media.download')}
              </button>
              {item.kind === 'hls' || item.kind === 'dash' ? (
                <button
                  type="button"
                  onClick={() => {
                    void sendMessage(browser.runtime, 'media.variants', { url: item.url }).then(
                      (found) => {
                        setVariants((current) => ({ ...current, [item.url]: found }));
                      },
                      () => undefined,
                    );
                  }}
                >
                  {t('media.qualities')}
                </button>
              ) : null}
              {(variants[item.url] ?? []).map((variant) => (
                <button
                  key={variant.url}
                  type="button"
                  onClick={() => send(variant.url, { quality: variant.quality, kind: item.kind })}
                >
                  {variant.quality}
                </button>
              ))}
            </li>
          );
        })}
      </ul>
      {note ? <p role="status">{note}</p> : null}
    </section>
  );
}
