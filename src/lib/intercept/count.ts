/** How many downloads this browser session has handed to DLM. The badge shows it while the connection is fine. */
export const HANDOFF_COUNT_KEY = 'intercept.handoffs';

/** A stored count. Rubbish and zero both read as zero. */
export function parseHandoffCount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(999, Math.floor(raw))
    : 0;
}
