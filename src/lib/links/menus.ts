import { t, type MessageKey } from '../i18n';

/** A queue the daemon listed. */
export interface QueueRef {
  id: string;
  name: string;
}

/** One context-menu entry. The browser creates it from this. */
export interface MenuSpec {
  id: string;
  title: string;
  contexts: MenuContext[];
  parentId?: string;
  type?: 'normal' | 'checkbox';
  checked?: boolean;
}

export type MenuContext = 'link' | 'selection' | 'image' | 'audio' | 'video' | 'page' | 'all';

const CONTEXTS: { id: Exclude<MenuContext, 'all'>; title: MessageKey }[] = [
  { id: 'link', title: 'menu.link' },
  { id: 'selection', title: 'menu.selection' },
  { id: 'image', title: 'menu.image' },
  { id: 'audio', title: 'menu.audio' },
  { id: 'video', title: 'menu.video' },
  { id: 'page', title: 'menu.page' },
];

/**
 * The context menus. Each place a person can right-click gets a submenu of queues, an "add paused" checkbox and, on a
 * page, "download all links". Queue ids are encoded in the menu id so a click needs no other state.
 */
export function menuTree(queues: readonly QueueRef[], addPaused: boolean): MenuSpec[] {
  const known = queues.length > 0 ? queues : [{ id: 'main', name: 'Main' }];
  const specs: MenuSpec[] = [];
  for (const context of CONTEXTS) {
    const parent = `dlm:${context.id}`;
    specs.push({ id: parent, title: t(context.title), contexts: [context.id] });
    for (const queue of known) {
      specs.push({
        id: `dlm:${context.id}:queue:${encodeURIComponent(queue.id)}`,
        parentId: parent,
        title: queue.name,
        contexts: [context.id],
      });
    }
    specs.push({
      id: `dlm:${context.id}:paused`,
      parentId: parent,
      title: t('menu.paused'),
      contexts: [context.id],
      type: 'checkbox',
      checked: addPaused,
    });
  }
  specs.push({
    id: 'dlm:all',
    title: t('menu.all'),
    contexts: ['page'],
  });
  return specs;
}

export type MenuAction =
  { kind: 'add'; context: MenuContext; queueId: string } | { kind: 'paused' } | { kind: 'all' };

/** What a menu id means. Undefined for an id this extension did not create. */
export function menuAction(id: string): MenuAction | undefined {
  if (id === 'dlm:all') return { kind: 'all' };
  const parts = id.split(':');
  if (parts[0] !== 'dlm' || parts.length < 2) return undefined;
  const context = parts[1];
  if (!isContext(context)) return undefined;
  if (parts[2] === 'paused') return { kind: 'paused' };
  if (parts[2] === 'queue' && parts[3]) {
    return { kind: 'add', context, queueId: decodeURIComponent(parts.slice(3).join(':')) };
  }
  return undefined;
}

function isContext(value: string | undefined): value is MenuContext {
  return (
    value === 'link' ||
    value === 'selection' ||
    value === 'image' ||
    value === 'audio' ||
    value === 'video' ||
    value === 'page'
  );
}

/** The address a menu click should download, for that context. */
export function targetUrl(
  context: MenuContext,
  info: {
    linkUrl?: string | undefined;
    srcUrl?: string | undefined;
    selectionText?: string | undefined;
    pageUrl?: string | undefined;
  },
): string | undefined {
  switch (context) {
    case 'link':
      return httpish(info.linkUrl);
    case 'image':
    case 'audio':
    case 'video':
      return httpish(info.srcUrl) ?? httpish(info.linkUrl);
    case 'selection':
      return httpish(info.selectionText?.trim());
    case 'page':
      return httpish(info.pageUrl);
    default:
      return undefined;
  }
}

function httpish(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (isDirectSchemeLoose(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ftp:')
      return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}

function isDirectSchemeLoose(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith('magnet:') || lower.startsWith('ed2k:');
}
