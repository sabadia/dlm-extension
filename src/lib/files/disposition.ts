/** The file name of a `Content-Disposition` header, including the UTF-8 `filename*` form, or undefined. */
export function nameFromDisposition(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)?'[^']*'([^;]+)/i
    .exec(value)?.[1]
    ?.trim()
    .replace(/^"|"$/g, '');
  if (extended) {
    try {
      return clean(decodeURIComponent(extended));
    } catch {
      return clean(extended);
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^";]+)/i.exec(value);
  return clean(plain?.[1] ?? plain?.[2]);
}

function clean(value: string | undefined): string | undefined {
  const base = value?.split(/[/\\]/).pop()?.trim();
  return base && base !== '.' && base !== '..' ? base : undefined;
}
