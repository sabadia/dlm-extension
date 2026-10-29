import { en, type MessageKey } from './en';

/** The text for `key`, with `{name}` placeholders filled from `values`. */
export function t(key: MessageKey, values: Record<string, string | number> = {}): string {
  return en[key].replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name] ?? `{${name}}`));
}

export type { MessageKey };
