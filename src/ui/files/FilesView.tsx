import { useEffect, useState } from 'preact/hooks';
import { applyView, countKinds, formatSize, type FileEntry } from '../../lib/files/entries';
import type { FileKind } from '../../lib/files/kinds';
import { t, type MessageKey } from '../../lib/i18n';
import type { Variant } from '../../lib/media/playlist';
import type { FileSort, Naming } from '../../lib/settings/schema';
import { Icon } from '../icons';
import {
  Badge,
  Button,
  Chip,
  Dialog,
  EmptyState,
  IconButton,
  Menu,
  Segmented,
  Skeleton,
  Spinner,
  useToasts,
} from '../kit';
import '../theme.css';
import './files.css';
import type { FilesApi, TabInfo } from './api';
import { FileRow, kindLabel } from './FileRow';
import { canSee, useFiles } from './use-files';

const KINDS: FileKind[] = ['video', 'audio', 'archive', 'document', 'app', 'stream', 'other'];
const SORTS: FileSort[] = ['size-desc', 'size-asc', 'name', 'type'];
const REASON_NOT_CONNECTED = new Set(['connected']);

const message = (error: unknown): string =>
  error instanceof Error ? error.message : t('error.failed');

type ConnectionKind = Awaited<ReturnType<FilesApi['connection']>>['kind'];

/** The files of the current tab, to send to DLM. It is the whole toolbar view, in the side panel or in the popup. */
export function FilesView({ api }: { api: FilesApi }) {
  const files = useFiles(api);
  const toasts = useToasts();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<FileKind | 'all'>('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [connection, setConnection] = useState<{ kind: ConnectionKind; text: string }>();
  const [queues, setQueues] = useState<{ id: string; name: string }[]>([]);
  const [queueId, setQueueId] = useState('');
  const [paused, setPaused] = useState(false);
  const [qualities, setQualities] = useState<Record<string, Variant[]>>({});
  const [cookies, setCookies] = useState<{ host: string; count: number }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.connection().then(setConnection, () => undefined);
    api.queues().then(setQueues, () => undefined);
  }, [api]);

  const { tab, settings, entries, names } = files;
  const sort = settings?.files.sort ?? 'size-desc';
  const naming = settings?.files.naming ?? 'title';
  const connected = connection ? REASON_NOT_CONNECTED.has(connection.kind) : false;
  const shown = applyView(entries, names, { query, kind, sort });
  const counts = countKinds(entries);
  const picked = entries.filter((entry) => selected.has(entry.id));
  const pickedSize = picked.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);

  const savePrefs = (change: { sort?: FileSort; naming?: Naming }) => {
    files
      .updatePrefs(change)
      .catch((error: unknown) =>
        toasts.show(t('files.failed', { message: message(error) }), 'error'),
      );
  };

  const request = (entry: FileEntry, extra: { quality?: string; browser?: boolean } = {}) => ({
    url: entry.url,
    ...(settings?.files.followRedirects !== false && entry.finalUrl !== entry.url
      ? { finalUrl: entry.finalUrl }
      : {}),
    name: names.get(entry.id) ?? entry.url,
    ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
    ...(entry.mime ? { mime: entry.mime } : {}),
    ...(entry.stream ? { kind: entry.stream } : {}),
    ...(extra.quality ? { quality: extra.quality } : {}),
    ...(extra.browser ? { resolverKind: 'browser' as const } : {}),
    ...(tab ? { pageUrl: tab.url, tabId: tab.id, incognito: tab.incognito } : {}),
    ...(tab?.cookieStoreId ? { cookieStoreId: tab.cookieStoreId } : {}),
    ...(queueId ? { queueId } : {}),
    ...(paused ? { paused: true } : {}),
  });

  const send = async (list: FileEntry[], extra: { quality?: string; browser?: boolean } = {}) => {
    setBusy(true);
    let ok = 0;
    let lastError = '';
    const failed = new Set<string>();
    for (const entry of list) {
      try {
        const result = await api.download(request(entry, extra));
        if (result.ok) ok += 1;
        else {
          lastError = result.error ?? '';
          failed.add(entry.id);
        }
      } catch (error) {
        lastError = message(error);
        failed.add(entry.id);
      }
    }
    setBusy(false);
    setSelected(new Set([...selected].filter((id) => failed.has(id))));
    if (failed.size === 0) {
      toasts.show(
        list.length === 1 ? t('files.sent') : t('files.sentMany', { ok, total: list.length }),
      );
    } else {
      toasts.show(t('files.failed', { message: lastError || t('error.failed') }), 'error');
    }
  };

  const pageAction = async (extra: { resolverKind: 'browser' | 'ytdlp' }) => {
    if (!tab) return;
    setBusy(true);
    try {
      const result = await api.download({
        url: tab.url,
        pageUrl: tab.url,
        resolverKind: extra.resolverKind,
        tabId: tab.id,
        incognito: tab.incognito,
        ...(tab.cookieStoreId ? { cookieStoreId: tab.cookieStoreId } : {}),
        ...(queueId ? { queueId } : {}),
        ...(paused ? { paused: true } : {}),
      });
      toasts.show(
        result.ok
          ? t('files.sent')
          : t('files.failed', { message: result.error ?? t('error.failed') }),
        result.ok ? 'info' : 'error',
      );
    } catch (error) {
      toasts.show(t('files.failed', { message: message(error) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const askCookies = async () => {
    if (!tab) return;
    try {
      const found = await api.cookiesPreview(cookieRequest(tab));
      if (found.count === 0) toasts.show(t('files.cookiesNone'));
      else setCookies(found);
    } catch (error) {
      toasts.show(t('files.failed', { message: message(error) }), 'error');
    }
  };

  const sendCookies = async () => {
    setCookies(undefined);
    if (!tab) return;
    try {
      const result = await api.sendCookies(cookieRequest(tab));
      if (result.ok) {
        const refused =
          result.rejected > 0 ? ` ${t('files.cookiesRefused', { rejected: result.rejected })}` : '';
        toasts.show(
          `${t('files.cookiesSent', { imported: result.imported, host: result.host })}${refused}`,
        );
      } else toasts.show(t('files.failed', { message: result.error }), 'error');
    } catch (error) {
      toasts.show(t('files.failed', { message: message(error) }), 'error');
    }
  };

  const loadQualities = (entry: FileEntry) => {
    api.variants(entry.url).then(
      (found) => setQualities((previous) => ({ ...previous, [entry.id]: found })),
      () => setQualities((previous) => ({ ...previous, [entry.id]: [] })),
    );
  };

  const unsupported = files.loaded && (!tab || !canSee(tab.url));
  const waiting = !files.loaded || (files.checking > 0 && entries.length === 0);

  return (
    <div class="app">
      <header class="top">
        <img class="logo" src="/icon-32.png" alt="" width="24" height="24" />
        <h1 class="title grow">{t('files.title')}</h1>
        <ConnectionPill connection={connection} onSetUp={() => api.openSetup()} />
        <IconButton icon="refresh" label={t('files.rescan')} onClick={() => files.rescan()} />
        <Menu
          label={t('files.pageMenu')}
          items={[
            {
              label: t('files.pageCookies'),
              icon: 'cookie',
              disabled: unsupported || !connected,
              onSelect: () => void askCookies(),
            },
            {
              label: t('files.pageBrowser'),
              icon: 'browser',
              disabled: unsupported || !connected || busy,
              onSelect: () => void pageAction({ resolverKind: 'browser' }),
            },
            {
              label: t('files.pageYtdlp'),
              icon: 'video',
              disabled: unsupported || !connected || busy,
              onSelect: () => void pageAction({ resolverKind: 'ytdlp' }),
            },
            {
              label: t('files.pageSettings'),
              icon: 'settings',
              separated: true,
              onSelect: () => api.openSettings(),
            },
          ]}
        />
      </header>

      {!connected && connection ? (
        <div class="notice" role="status">
          <Icon name="info" />
          <span class="grow">{t('files.connectFirst')}</span>
          <Button size="small" variant="primary" onClick={() => api.openSetup()}>
            {t('files.setUp')}
          </Button>
        </div>
      ) : null}

      {files.view.protectedMedia ? (
        <div class="notice warn" role="status">
          <Icon name="alert" />
          <span>{t('files.protected')}</span>
        </div>
      ) : null}

      {unsupported ? (
        <EmptyState icon="globe" title={t('files.unsupported')}>
          {t('files.unsupportedHelp')}
        </EmptyState>
      ) : (
        <>
          <div class="controls">
            <label class="search">
              <Icon name="search" />
              <input
                class="input"
                type="search"
                value={query}
                aria-label={t('files.search')}
                placeholder={t('files.searchPlaceholder')}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <div class="chips" role="group" aria-label={t('files.title')}>
              <Chip pressed={kind === 'all'} onClick={() => setKind('all')} count={entries.length}>
                {t('files.kind.all')}
              </Chip>
              {KINDS.filter((item) => counts.has(item)).map((item) => (
                <Chip
                  key={item}
                  pressed={kind === item}
                  onClick={() => setKind(item)}
                  count={counts.get(item) ?? 0}
                >
                  {kindLabel(item)}
                </Chip>
              ))}
            </div>
            <div class="row between wrap">
              <label class="row small">
                <span class="muted">{t('files.sort')}</span>
                <select
                  class="select compact"
                  value={sort}
                  onChange={(event) => savePrefs({ sort: event.currentTarget.value as FileSort })}
                >
                  {SORTS.map((item) => (
                    <option key={item} value={item}>
                      {t(`files.sort.${item}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </label>
              <Segmented
                label={t('files.naming')}
                value={naming}
                options={[
                  { value: 'title', label: t('files.naming.title') },
                  { value: 'url', label: t('files.naming.url') },
                ]}
                onChange={(value) => savePrefs({ naming: value })}
              />
            </div>
          </div>

          <main class="list" aria-busy={waiting}>
            {files.checking > 0 ? (
              <p class="status small muted">
                <Spinner label={t('files.checking', { count: files.checking })} />
                {t('files.checking', { count: files.checking })}
              </p>
            ) : null}
            {waiting && entries.length === 0 ? (
              <div class="skeletons" aria-hidden="true">
                {[0, 1, 2].map((index) => (
                  <div key={index} class="skeleton-row">
                    <Skeleton width="2rem" height="2rem" />
                    <div class="grow stack">
                      <Skeleton width="70%" />
                      <Skeleton width="40%" height="0.75rem" />
                    </div>
                  </div>
                ))}
              </div>
            ) : shown.length === 0 ? (
              <EmptyState
                icon="file"
                title={entries.length === 0 ? t('files.empty') : t('files.empty')}
              >
                {entries.length === 0 ? t('files.emptyHelp') : undefined}
              </EmptyState>
            ) : (
              <>
                <label class="row small select-all">
                  <input
                    type="checkbox"
                    class="check"
                    checked={shown.every((entry) => selected.has(entry.id))}
                    onChange={(event) =>
                      setSelected(
                        event.currentTarget.checked
                          ? new Set(shown.map((entry) => entry.id))
                          : new Set(),
                      )
                    }
                  />
                  <span>{t('files.selectAll')}</span>
                </label>
                <ul class="files">
                  {shown.map((entry) => (
                    <FileRow
                      key={entry.id}
                      entry={entry}
                      name={names.get(entry.id) ?? entry.url}
                      selected={selected.has(entry.id)}
                      canDownload={connected && !busy}
                      qualities={qualities[entry.id]}
                      onSelect={(on) =>
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (on) next.add(entry.id);
                          else next.delete(entry.id);
                          return next;
                        })
                      }
                      onRename={(name) => files.rename(entry.id, name)}
                      onDownload={(quality) => void send([entry], quality ? { quality } : {})}
                      onDownloadInBrowser={() => void send([entry], { browser: true })}
                      onLoadQualities={() => loadQualities(entry)}
                      onCopy={() => {
                        api.copy(entry.finalUrl).then(
                          () => toasts.show(t('files.copied')),
                          (error: unknown) => toasts.show(message(error), 'error'),
                        );
                      }}
                    />
                  ))}
                </ul>
              </>
            )}
          </main>

          {picked.length > 0 ? (
            <footer class="bar">
              <div class="row between">
                <span class="small muted">
                  {t('files.selectedCount', { count: picked.length })}
                </span>
                <div class="row">
                  {queues.length > 1 ? (
                    <select
                      class="select compact"
                      aria-label={t('files.queue')}
                      value={queueId}
                      onChange={(event) => setQueueId(event.currentTarget.value)}
                    >
                      <option value="">{t('files.queue')}</option>
                      {queues.map((queue) => (
                        <option key={queue.id} value={queue.id}>
                          {queue.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <label class="row small">
                    <input
                      type="checkbox"
                      class="check"
                      checked={paused}
                      onChange={(event) => setPaused(event.currentTarget.checked)}
                    />
                    {t('files.paused')}
                  </label>
                </div>
              </div>
              <Button
                variant="primary"
                block
                icon="download"
                disabled={!connected || busy}
                onClick={() => void send(picked)}
              >
                {t('files.downloadSelected', {
                  count: picked.length,
                  size: formatSize(pickedSize) || '—',
                })}
              </Button>
            </footer>
          ) : null}
        </>
      )}

      {cookies ? (
        <Dialog
          title={t('files.cookiesTitle')}
          confirmLabel={t('files.cookiesSend')}
          cancelLabel={t('files.cancel')}
          onConfirm={() => void sendCookies()}
          onCancel={() => setCookies(undefined)}
        >
          <p>{t('files.cookiesBody', { count: cookies.count, host: cookies.host })}</p>
        </Dialog>
      ) : null}
      {toasts.host}
    </div>
  );
}

function cookieRequest(tab: TabInfo) {
  return {
    url: tab.url,
    tabId: tab.id,
    incognito: tab.incognito,
    ...(tab.cookieStoreId ? { cookieStoreId: tab.cookieStoreId } : {}),
  };
}

function ConnectionPill({
  connection,
  onSetUp,
}: {
  connection: { kind: ConnectionKind; text: string } | undefined;
  onSetUp: () => void;
}) {
  if (!connection) return null;
  if (connection.kind === 'connected')
    return (
      <Badge tone="success" dot>
        {t('files.connected')}
      </Badge>
    );
  if (connection.kind === 'app-not-running')
    return (
      <Badge tone="warning" dot>
        {t('files.notRunning')}
      </Badge>
    );
  return (
    <Button size="small" variant="ghost" onClick={onSetUp} title={connection.text}>
      {t('files.setUp')}
    </Button>
  );
}
