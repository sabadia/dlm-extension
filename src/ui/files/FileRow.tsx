import { useEffect, useRef, useState } from 'preact/hooks';
import { formatSize, type FileEntry } from '../../lib/files/entries';
import type { FileKind } from '../../lib/files/kinds';
import { t, type MessageKey } from '../../lib/i18n';
import type { Variant } from '../../lib/media/playlist';
import { Icon, type IconName } from '../icons';
import { Badge, Menu } from '../kit';

const KIND_ICON: Record<FileKind, IconName> = {
  video: 'video',
  audio: 'audio',
  archive: 'archive',
  document: 'doc',
  app: 'app',
  image: 'image',
  stream: 'stream',
  other: 'file',
};

export function kindLabel(kind: FileKind): string {
  return t(`files.kind.${kind}` as MessageKey);
}

/** One file: its type, name (click to rename), size, host, and what can be done with it. */
export function FileRow({
  entry,
  name,
  selected,
  canDownload,
  qualities,
  onSelect,
  onRename,
  onDownload,
  onDownloadInBrowser,
  onLoadQualities,
  onCopy,
}: {
  entry: FileEntry;
  name: string;
  selected: boolean;
  canDownload: boolean;
  /** The qualities of a stream, once asked for. */
  qualities: Variant[] | undefined;
  onSelect: (selected: boolean) => void;
  onRename: (name: string) => void;
  onDownload: (quality?: string) => void;
  onDownloadInBrowser: () => void;
  onLoadQualities: () => void;
  onCopy: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const finish = (keep: boolean) => {
    setEditing(false);
    const next = draft.trim();
    if (keep && next !== '' && next !== name) onRename(next);
    else setDraft(name);
  };

  const meta = [
    entry.stream ? undefined : formatSize(entry.sizeBytes),
    entry.ext?.toUpperCase(),
    entry.host,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  return (
    <li class="file" data-kind={entry.kind}>
      <input
        type="checkbox"
        class="check"
        checked={selected}
        aria-label={t('files.downloadFile', { name })}
        onChange={(event) => onSelect(event.currentTarget.checked)}
      />
      <span class="kind" aria-hidden="true">
        <Icon name={KIND_ICON[entry.kind]} />
      </span>
      <div class="grow body">
        {editing ? (
          <input
            ref={input}
            class="input rename"
            value={draft}
            aria-label={t('files.renameLabel')}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => finish(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') finish(true);
              if (event.key === 'Escape') finish(false);
            }}
          />
        ) : (
          <button
            type="button"
            class="name"
            title={name}
            aria-label={t('files.rename', { name })}
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
          >
            {name}
          </button>
        )}
        <div class="meta small muted truncate" title={meta}>
          {entry.stream ? <Badge tone="accent">{kindLabel('stream')}</Badge> : null} {meta}
        </div>
        {qualities !== undefined ? (
          <div class="chips qualities">
            {qualities.length === 0 ? (
              <span class="small muted">{t('files.noQualities')}</span>
            ) : (
              qualities.map((variant) => (
                <button
                  key={`${variant.url}\n${variant.hint}\n${variant.bandwidth ?? ''}`}
                  type="button"
                  class="chip"
                  disabled={!canDownload}
                  onClick={() => onDownload(variant.hint)}
                >
                  {variant.quality}
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        class="btn primary dl"
        aria-label={t('files.downloadFile', { name })}
        title={t('files.download')}
        disabled={!canDownload}
        onClick={() => onDownload()}
      >
        <Icon name="download" />
      </button>
      <Menu
        label={t('files.menu', { name })}
        items={[
          {
            label: t('files.menuBrowser'),
            icon: 'browser',
            disabled: !canDownload,
            onSelect: onDownloadInBrowser,
          },
          ...(entry.stream
            ? [
                {
                  label: t('files.menuQuality'),
                  icon: 'stream' as const,
                  onSelect: onLoadQualities,
                },
              ]
            : []),
          { label: t('files.menuCopy'), icon: 'copy', onSelect: onCopy },
        ]}
      />
    </li>
  );
}
