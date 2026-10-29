import { t } from '../../src/lib/i18n';
import { PRODUCT_NAME } from '../../src/lib/product';

export function App() {
  return (
    <main>
      <h1>{PRODUCT_NAME}</h1>
      <p>{t('popup.notConnected')}</p>
    </main>
  );
}
