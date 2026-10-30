import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  applyView,
  entryFor,
  needsCheck,
  nameFacts,
  type FileEntry,
} from '../../lib/files/entries';
import { assignNames } from '../../lib/files/naming';
import { runPool, type ProbeResult } from '../../lib/files/probe';
import type { TabView } from '../../lib/media/service';
import type { FilesPrefs, Settings } from '../../lib/settings/schema';
import type { FilesApi, TabInfo } from './api';

/** At most this many addresses of one page are checked, and this many at a time. */
export const MAX_CHECKS = 60;
export const CHECK_CONCURRENCY = 4;
const REFRESH_MS = 2000;

const EMPTY_VIEW: TabView = {
  items: [],
  title: '',
  protectedMedia: false,
  blobOrMse: false,
  pageUrl: '',
};

/** A page the extension can look at: an ordinary web page. */
export function canSee(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export interface FilesState {
  tab: TabInfo | undefined;
  /** False until the first answer about the tab has arrived. */
  loaded: boolean;
  settings: Settings | undefined;
  view: TabView;
  /** Valid files, named. */
  entries: FileEntry[];
  /** The name each file is saved as (the title or the file name, and any rename). */
  names: ReadonlyMap<string, string>;
  /** How many addresses are still being checked. */
  checking: number;
  rename(id: string, name: string): void;
  rescan(): void;
  /** Changes the Files settings: the view follows at once, and the change is saved. */
  updatePrefs(change: Partial<FilesPrefs>): Promise<void>;
}

/**
 * The files of the active tab: the media list from the background, each unsized row checked in the panel (so the check
 * runs for as long as the panel is open, not for as long as a service worker lives), the valid ones named. It looks
 * again when the tab changes and every two seconds, because the page keeps loading files.
 */
export function useFiles(api: FilesApi): FilesState {
  const [tab, setTab] = useState<TabInfo>();
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings>();
  const [view, setView] = useState<TabView>(EMPTY_VIEW);
  const [probes, setProbes] = useState<Readonly<Record<string, ProbeResult>>>({});
  const [renames, setRenames] = useState<Readonly<Record<string, string>>>({});
  const asked = useRef(new Set<string>());
  const force = useRef(false);
  const aborter = useRef(new AbortController());

  const refresh = useCallback(async () => {
    try {
      const current = await api.activeTab();
      setTab((previous) =>
        previous?.id === current?.id && previous?.url === current?.url ? previous : current,
      );
      setView(current && canSee(current.url) ? await api.mediaList(current.id) : EMPTY_VIEW);
    } catch {
      // The background is busy or restarting: the next look will do.
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void api.settings().then(
      (loadedSettings) => {
        setSettings(loadedSettings);
      },
      () => undefined,
    );
    void refresh();
    const stop = api.subscribe(() => void refresh());
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      stop();
      clearInterval(timer);
      aborter.current.abort();
    };
  }, [api, refresh]);

  // A new page starts again: what was asked about the old one does not carry over, and neither do renames.
  const pageKey = `${tab?.id ?? ''}|${view.pageUrl}`;
  useEffect(() => {
    asked.current = new Set();
    setProbes({});
    setRenames({});
  }, [pageKey]);

  const todo = useMemo(
    () => view.items.filter((row) => needsCheck(row, probes[row.url])).map((row) => row.url),
    [view.items, probes],
  );

  useEffect(() => {
    const fresh = todo
      .filter((url) => !asked.current.has(url))
      .slice(0, Math.max(0, MAX_CHECKS - asked.current.size));
    if (fresh.length === 0) return;
    for (const url of fresh) asked.current.add(url);
    const forced = force.current;
    force.current = false;
    void runPool(
      fresh,
      CHECK_CONCURRENCY,
      async (url) => {
        const result = await api.probe(
          url,
          { pageUrl: view.pageUrl, incognito: tab?.incognito ?? false },
          forced,
        );
        // A check that could not reach the server is asked again later; any other answer is final.
        if (!result.ok && result.reason === 'network') asked.current.delete(url);
        else setProbes((previous) => ({ ...previous, [url]: result }));
      },
      aborter.current.signal,
    );
  }, [todo, api]);

  const follow = settings?.files.followRedirects ?? true;
  const checked = view.items.map((row) => entryFor(row, probes[row.url], follow));
  const entries = checked.filter((item) => item.state === 'valid').map((item) => item.entry);
  const checking = checked.filter(
    (item) => item.state === 'pending' && asked.current.has(item.entry.id),
  ).length;

  const naming = settings?.files.naming ?? 'title';
  const names = useMemo(() => {
    const assigned = assignNames(entries.map(nameFacts), view.title || tab?.title || '', naming);
    for (const [id, name] of Object.entries(renames)) if (assigned.has(id)) assigned.set(id, name);
    return assigned;
  }, [
    entries.map((entry) => `${entry.id}|${entry.finalUrl}|${entry.serverName ?? ''}`).join('\n'),
    view.title,
    tab?.title,
    naming,
    renames,
  ]);

  return {
    tab,
    loaded,
    settings,
    view,
    entries,
    names,
    checking,
    updatePrefs: async (change) => {
      if (!settings) return;
      const next = { ...settings.files, ...change };
      setSettings({ ...settings, files: next });
      await api.saveFiles(next);
    },
    rename: (id, name) => setRenames((previous) => ({ ...previous, [id]: name })),
    rescan: () => {
      force.current = true;
      asked.current = new Set();
      setProbes({});
      void refresh();
    },
  };
}

export { applyView };
