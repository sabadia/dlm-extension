import type { AskChoice } from '../../src/lib/intercept/service';
import { t } from '../../src/lib/i18n';

/** The three choices of ask-first. The background does the work; this only reports which button was pressed. */
export function App({
  name,
  host,
  onChoose,
}: {
  name: string;
  host: string;
  onChoose: (choice: AskChoice) => void;
}) {
  return (
    <main>
      <p>{name ? t('intercept.ask.prompt', { name, host }) : t('intercept.ask.gone')}</p>
      {name ? (
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
        </>
      ) : null}
    </main>
  );
}
