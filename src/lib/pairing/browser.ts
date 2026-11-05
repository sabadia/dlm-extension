/** The names the daemon accepts for a pairing's browser. */
export type BrowserName =
  'chrome' | 'chromium' | 'edge' | 'brave' | 'opera' | 'vivaldi' | 'firefox' | 'safari' | 'other';

/**
 * The names of the browsers the daemon knows. Safari is not one of them (yet): it is sent as `other`.
 */
export function daemonBrowserName(name: BrowserName): Exclude<BrowserName, 'safari'> {
  return name === 'safari' ? 'other' : name;
}

/**
 * Tells the browser from its user agent. Brave does not say so in it: pass `braveFlag` (`navigator.brave` exists).
 * Chromium-based browsers that hide themselves are `chrome`, which is what their extension id registration uses anyway.
 */
export function detectBrowser(userAgent: string, braveFlag = false): BrowserName {
  if (braveFlag) return 'brave';
  if (/Firefox\//.test(userAgent)) return 'firefox';
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return 'edge';
  if (/OPR\/|Opera\//.test(userAgent)) return 'opera';
  if (/Vivaldi\//.test(userAgent)) return 'vivaldi';
  if (/Chromium\//.test(userAgent)) return 'chromium';
  if (/Chrome\//.test(userAgent)) return 'chrome';
  // Safari names its version and itself, and none of the Chromium names above.
  if (/Version\/[\d.]+.*Safari\//.test(userAgent)) return 'safari';
  return 'other';
}
