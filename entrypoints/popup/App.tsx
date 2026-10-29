import { t } from '../../src/lib/i18n';
import { PRODUCT_NAME } from '../../src/lib/product';
import { PairingPanel } from '../../src/ui/PairingPanel';

export function App() {
  // The connection state machine (E1.6) decides what the popup shows; until then it offers to pair.
  return (
    <main>
      <h1>{PRODUCT_NAME}</h1>
      <p>{t('popup.notConnected')}</p>
      <PairingPanel />
    </main>
  );
}
