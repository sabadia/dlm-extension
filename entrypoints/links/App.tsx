import { useState } from 'preact/hooks';
import { t } from '../../src/lib/i18n';
import { filterLinks, patternRejected, type PageLink } from '../../src/lib/links/filter';

/** The preview of links on a page. Filtering is pure; sending is the callback. */
export function App({
  links,
  onSend,
}: {
  links: readonly PageLink[];
  onSend: (urls: string[]) => Promise<{ ok: number; failed: number }>;
}) {
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
        <input value={extensions} onInput={(event) => setExtensions(event.currentTarget.value)} />
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
