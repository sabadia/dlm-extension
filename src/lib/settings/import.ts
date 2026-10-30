import { LOCAL_TARGET, type Settings, type Target } from './schema';

/**
 * Decides what an imported settings file may change. A file can come from anywhere, so it must not be able to point a
 * server the person already trusts (and whose token the extension holds) at another address:
 *
 * - a remote server of the file that is already known with the same address keeps its id (and so its token);
 * - any other remote server gets a new id, so it has no token until the person enters one, is not the active target,
 *   and no site route may use it;
 * - servers that are not in the file are dropped (the caller removes their tokens).
 */
export function adoptImported(
  current: Settings,
  incoming: Settings,
  newId: () => string,
): Settings {
  const known = new Map(current.targets.map((target) => [target.id, target]));
  const targets: Target[] = [{ ...LOCAL_TARGET }];
  const trusted = new Set<string>([LOCAL_TARGET.id]);
  for (const target of incoming.targets) {
    if (target.kind !== 'remote') continue;
    const was = known.get(target.id);
    if (was?.kind === 'remote' && was.url === target.url) {
      targets.push({ ...target });
      trusted.add(target.id);
    } else {
      targets.push({ ...target, id: newId() });
    }
  }
  return {
    ...incoming,
    targets,
    routes: incoming.routes.filter((route) => trusted.has(route.targetId)),
    activeTargetId: trusted.has(incoming.activeTargetId)
      ? incoming.activeTargetId
      : LOCAL_TARGET.id,
  };
}
