/** One quality of an HLS master playlist or a DASH manifest. */
export interface Variant {
  /** The address of this quality's own playlist or file; the manifest itself when the manifest has one for all. */
  url: string;
  /** A short label such as `1080p` or `audio`. */
  quality: string;
  /**
   * What is sent with the manifest to choose this quality: the daemon reads the master playlist itself, picks the
   * variant and adds the separate audio, so the manifest travels with this hint, not the variant's own address.
   */
  hint: string;
  bandwidth?: number | undefined;
}

// ---- HLS ----

/** The attributes of a tag line (`KEY=VALUE,KEY="a,b"`). Keys are matched whole: `BANDWIDTH` is not `AVERAGE-BANDWIDTH`. */
export function hlsAttributes(line: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = line.slice(line.indexOf(':') + 1);
  for (const match of body.matchAll(/([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    const key = match[1];
    const raw = match[2];
    if (key !== undefined && raw !== undefined)
      out.set(key.toUpperCase(), raw.replace(/^"|"$/g, ''));
  }
  return out;
}

/**
 * Reads an HLS master playlist. A media playlist (no `#EXT-X-STREAM-INF`) has no variants: the file itself is the
 * download. Relative addresses are resolved against `base`.
 */
export function parseHls(text: string, base: string): Variant[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const variants: Variant[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line?.startsWith('#EXT-X-STREAM-INF')) continue;
    const next = lines.slice(i + 1).find((item) => item !== '' && !item.startsWith('#'));
    if (!next) continue;
    const url = resolve(next, base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const attributes = hlsAttributes(line);
    const height = /^\d+x(\d+)$/i.exec(attributes.get('RESOLUTION') ?? '')?.[1];
    const bandwidth = Number(attributes.get('BANDWIDTH') ?? attributes.get('AVERAGE-BANDWIDTH'));
    const audioOnly =
      height === undefined && /^(mp4a|ac-3|ec-3|opus|flac)/i.test(attributes.get('CODECS') ?? '');
    variants.push({
      url,
      quality: height ? `${height}p` : audioOnly ? 'audio' : 'video',
      hint: height ? `${height}p` : url,
      ...(Number.isFinite(bandwidth) && bandwidth > 0 ? { bandwidth } : {}),
    });
  }
  return variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
}

// ---- DASH ----

interface XmlNode {
  /** The tag name without its namespace prefix. */
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isInteger(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** A small tolerant XML reader: enough for a manifest, with no DOM (the background has none). */
export function parseXml(text: string): XmlNode | undefined {
  const root: XmlNode = { name: '#root', attributes: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const pattern =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
  for (const match of text.matchAll(pattern)) {
    const [, cdata, closing, rawName, rawAttributes, selfClosing, chars] = match;
    const top = stack[stack.length - 1];
    if (!top) return undefined;
    if (cdata !== undefined) {
      top.text += cdata;
    } else if (chars !== undefined) {
      top.text += decodeEntities(chars);
    } else if (rawName !== undefined) {
      const name = rawName.slice(rawName.indexOf(':') + 1);
      if (closing) {
        // Close up to the matching open tag; an unmatched close tag is ignored.
        const index = stack.map((node) => node.name).lastIndexOf(name);
        if (index > 0) stack.length = index;
        continue;
      }
      const node: XmlNode = { name, attributes: {}, children: [], text: '' };
      for (const attribute of (rawAttributes ?? '').matchAll(
        /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
      )) {
        const key = attribute[1];
        if (key !== undefined) {
          node.attributes[key.slice(key.indexOf(':') + 1)] = decodeEntities(
            attribute[2] ?? attribute[3] ?? '',
          );
        }
      }
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  return root.children[0];
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((item) => item.name === name);
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((item) => item.name === name);
}

/** The `BaseURL` of a node resolved against the address above it. */
function baseOf(node: XmlNode, above: string): string {
  const own = child(node, 'BaseURL')?.text.trim();
  return own ? (resolve(own, above) ?? above) : above;
}

/**
 * Reads a DASH MPD. Each `Representation` becomes a variant. Its address is its own `BaseURL`, resolved through the
 * `BaseURL` of the manifest, period and adaptation set above it, or the manifest itself when the segments come from a
 * template. The label is the height, else `audio` or `video` from the type it inherits from its adaptation set.
 */
export function parseDash(text: string, base: string): Variant[] {
  const mpd = parseXml(text);
  if (mpd?.name !== 'MPD') return [];
  const variants: Variant[] = [];
  const seen = new Set<string>();
  const mpdBase = baseOf(mpd, base);
  for (const period of children(mpd, 'Period')) {
    const periodBase = baseOf(period, mpdBase);
    for (const set of children(period, 'AdaptationSet')) {
      const setBase = baseOf(set, periodBase);
      for (const representation of children(set, 'Representation')) {
        const own = child(representation, 'BaseURL')?.text.trim();
        const url = own ? (resolve(own, setBase) ?? base) : base;
        const attribute = (name: string) => representation.attributes[name] ?? set.attributes[name];
        const type =
          `${attribute('mimeType') ?? ''} ${attribute('contentType') ?? ''}`.toLowerCase();
        const height = /^\d+$/.test(attribute('height') ?? '') ? attribute('height') : undefined;
        const bandwidth = Number(representation.attributes.bandwidth);
        const quality = height ? `${height}p` : type.includes('audio') ? 'audio' : 'video';
        const id = representation.attributes.id ?? '';
        const key = `${url}\n${id}\n${quality}\n${bandwidth}`;
        if (seen.has(key)) continue;
        seen.add(key);
        variants.push({
          url,
          quality,
          // A height the daemon understands; otherwise the representation id it can match in the manifest.
          hint: height ? `${height}p` : id || quality,
          ...(Number.isFinite(bandwidth) && bandwidth > 0 ? { bandwidth } : {}),
        });
      }
    }
  }
  return variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
}

function resolve(ref: string, base: string): string | undefined {
  try {
    return new URL(ref, base).href;
  } catch {
    return undefined;
  }
}
