import { useState } from 'preact/hooks';
import { t } from '../../src/lib/i18n';
import { filterLinks, patternRejected, type PageLink } from '../../src/lib/links/filter';

/** How many links one "check sizes" asks about (DLM probes them one by one). */
const PROBE_LIMIT = 8;

/** The preview of links on a page. Filtering is pure; sending is the callback. */
export function App({
  links: found,
  onSend,
  onProbe,
}: {
  links: readonly PageLink[];
  onSend: (urls: string[]) => Promise<{ ok: number; failed: number }>;
  /** Asks DLM for the size of some addresses. */
  onProbe: (urls: string[]) => Promise<{ url: string; size?: number }[]>;
}) {
  const [sizes, setSizes] = useState<Readonly<Record<string, number>>>({});
  const [probing, setProbing] = useState(false);
  const [checked, setChecked] = useState('');
  // A page does not say how big a link is: the size filter works on what DLM was asked.
  const links = found.map((link) =>
    sizes[link.url] === undefined ? link : { ...link, sizeBytes: sizes[link.url] },
  );
  const [extensions, setExtensions] = useState('');
  const [pattern, setPattern] = useState('');
  const [minSize, setMinSize] = useState('0');
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () => new Set(links.map((link) => link.url)),
  );
  const [result, setResult] = useState('');
  const size = Number(minSize);
  const shown = filterLinks(links, {
    extensions: extensions
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => item !== ''),
    pattern,
    minSizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
  });
  const badPattern = patternRejected(pattern);
  const toggle = (url: string) => {
    const next = new Set(picked);
    if (next.has(url)) next.delete(url);
    else next.add(url);
    setPicked(next);
  };
  return (
    <main>
      <h1>{t('links.title')}</h1>
      <label>
        {t('links.extensions')}
        <input
          value={extensions}
          aria-describedby="links-extensions-hint"
          onInput={(event) => setExtensions(event.currentTarget.value)}
        />
        <span id="links-extensions-hint">{t('links.extensionsHint')}</span>
      </label>
      <label>
        {t('links.pattern')}
        <input value={pattern} onInput={(event) => setPattern(event.currentTarget.value)} />
      </label>
      {badPattern ? <p>{t('links.patternBad')}</p> : null}
      <label>
        {t('links.size')}
        <input
          value={minSize}
          inputMode="numeric"
          onInput={(event) => setMinSize(event.currentTarget.value)}
        />
      </label>
      <p>
        <button
          type="button"
          disabled={probing || shown.length === 0}
          onClick={() => {
            setProbing(true);
            void onProbe(shown.map((link) => link.url).slice(0, PROBE_LIMIT))
              .then((probed) => {
                const next = { ...sizes };
                for (const item of probed) if (item.size !== undefined) next[item.url] = item.size;
                setSizes(next);
                setChecked(t('links.sizesChecked', { count: probed.length }));
              })
              .catch(() => setChecked(t('error.failed')))
              .finally(() => setProbing(false));
          }}
        >
          {t('links.checkSizes')}
        </button>{' '}
        <span role="status">{checked}</span>
      </p>
      <p>
        <button type="button" onClick={() => setPicked(new Set(shown.map((link) => link.url)))}>
          {t('links.selectAll')}
        </button>{' '}
        <button type="button" onClick={() => setPicked(new Set())}>
          {t('links.selectNone')}
        </button>
      </p>
      {shown.length === 0 ? <p>{t('links.empty')}</p> : null}
      <ul>
        {shown.map((link) => (
          <li key={link.url}>
            <label>
              <input
                type="checkbox"
                checked={picked.has(link.url)}
                onChange={() => toggle(link.url)}
              />{' '}
              {link.text}
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          const urls = shown.filter((link) => picked.has(link.url)).map((link) => link.url);
          void onSend(urls).then((sent) =>
            setResult(
              sent.failed > 0
                ? t('links.sentSome', { ok: sent.ok, failed: sent.failed })
                : t('links.sent', { ok: sent.ok }),
            ),
          );
        }}
      >
        {t('links.send')}
      </button>
      {result ? <p>{result}</p> : null}
    </main>
  );
}
