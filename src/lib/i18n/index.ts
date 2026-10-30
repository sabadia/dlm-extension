import { en, type MessageKey } from './en';

/** The text for `key`, with `{name}` placeholders filled from `values`. */
export function t(key: MessageKey, values: Record<string, string | number> = {}): string {
  return en[key].replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name] ?? `{${name}}`));
}

export type { MessageKey };

/** The word for a task status of the daemon; an unknown status is shown as it is. */
export function statusText(status: string): string {
  const key = `status.${status}`;
  return key in en ? t(key as MessageKey) : status;
}
