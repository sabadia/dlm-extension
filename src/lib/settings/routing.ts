import { downloadHost, hostCoveredBy } from '../intercept/rules';
import type { Settings } from './schema';

/**
 * The target a download goes to. The longest matching site wins; a site includes its subdomains. Anything else uses
 * the default target (`activeTargetId`).
 */
export function targetFor(settings: Settings, url: string): string {
  const host = downloadHost(url);
  if (!host) return settings.activeTargetId;
  const known = new Set(settings.targets.map((target) => target.id));
  const matches = settings.routes.filter(
    (route) => known.has(route.targetId) && hostCoveredBy(host, route.site),
  );
  matches.sort((a, b) => b.site.length - a.site.length);
  return matches[0]?.targetId ?? settings.activeTargetId;
}
