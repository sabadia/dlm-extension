import { downloadHost, hostCoveredBy } from '../intercept/rules';

/** What the Files panel may do when it checks an address a page offers. */
export type ProbePolicy =
  { allowed: true; credentials: 'include' | 'omit' } | { allowed: false; reason: 'blocked' };

function privateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.startsWith('[') || host.includes(':')) return true; // an IPv6 address
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * The page decides which addresses the panel looks at, so the panel limits what a hostile page can make it do:
 * an address on this computer or the local network is looked at only when the page itself is there, and cookies go
 * only to the page's own site (the host and its parent or sub domains) and never from a private window. Without
 * cookies a link that needs a sign-in simply is not listed.
 */
export function probePolicy(pageUrl: string, url: string, incognito: boolean): ProbePolicy {
  const target = downloadHost(url);
  if (!target) return { allowed: false, reason: 'blocked' };
  const page = downloadHost(pageUrl);
  if (privateHost(target) && !(page && privateHost(page)))
    return { allowed: false, reason: 'blocked' };
  const sameSite =
    page !== undefined && (hostCoveredBy(target, page) || hostCoveredBy(page, target));
  return { allowed: true, credentials: sameSite && !incognito ? 'include' : 'omit' };
}
