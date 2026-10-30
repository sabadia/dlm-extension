import type { AskChoice, AskPurpose } from '../../src/lib/intercept/service';
import { t } from '../../src/lib/i18n';

/** The choices of ask-first, and the checksum review. The background does the work; this only reports the button. */
export function App({
  name,
  host,
  purpose,
  checksum,
  onChoose,
}: {
  name: string;
  host: string;
  purpose: AskPurpose;
  checksum?: { algorithm: string; expected: string } | undefined;
  onChoose: (choice: AskChoice) => void;
}) {
  const hash = checksum
    ? t('intercept.checksum', { algorithm: checksum.algorithm, expected: checksum.expected })
    : '';
  return (
    <main>
      <p>{name ? t('intercept.ask.prompt', { name, host }) : t('intercept.ask.gone')}</p>
      {hash ? <p>{hash}</p> : null}
      {name && purpose === 'checksum' ? (
        <>
          <button type="button" onClick={() => onChoose('dlm')}>
            {t('intercept.checksum.use')}
          </button>
          <button type="button" onClick={() => onChoose('omit')}>
            {t('intercept.checksum.omit')}
          </button>
        </>
      ) : null}
      {name && purpose !== 'checksum' ? (
        <>
          <button type="button" onClick={() => onChoose('dlm')}>
            {t('intercept.ask.dlm')}
          </button>
          <button type="button" onClick={() => onChoose('browser')}>
            {t('intercept.ask.browser')}
          </button>
          <button type="button" onClick={() => onChoose('always')}>
            {t('intercept.ask.always')}
          </button>
          {checksum ? (
            <button type="button" onClick={() => onChoose('omit')}>
              {t('intercept.checksum.omit')}
            </button>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
