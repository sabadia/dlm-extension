import type { Surface } from '../lib/settings/schema';

/** The browser calls the surface needs. Chrome has `sidePanel`, Firefox has `sidebarAction`; either may be absent. */
export interface SurfaceApi {
  /** `action.setPopup`: an empty string means the toolbar button has no popup, so a click is an event. */
  setPopup(popup: string): Promise<void> | void;
  /** Chrome: clicking the toolbar button opens the side panel by itself. */
  openPanelOnActionClick?(on: boolean): Promise<void> | void;
  /** Chrome: opens the side panel of a tab. Must be called from a user action. */
  openSidePanel?(tabId: number): Promise<void> | void;
  /** Firefox: opens the sidebar. Must be called from a user action. */
  openSidebar?(): Promise<void> | void;
  /** `action.openPopup`: opens the popup of the toolbar button. */
  openPopup?(): Promise<void> | void;
}

/** The page the popup is. */
export const POPUP_PATH = 'popup.html';

/**
 * Where the files of the tab are shown when the toolbar button is clicked: a side panel (default) or a popup. The
 * browser forgets the popup choice when it closes, so this runs every time the background loads and when the
 * setting changes.
 */
export async function applySurface(api: SurfaceApi, surface: Surface): Promise<void> {
  const panel = surface === 'panel';
  await api.setPopup(panel ? '' : POPUP_PATH);
  await api.openPanelOnActionClick?.(panel);
}

/** What the toolbar button does when it has no popup: Firefox opens its sidebar; Chrome's panel opens by itself. */
export async function onActionClicked(api: SurfaceApi, tabId: number | undefined): Promise<void> {
  if (api.openSidebar) await api.openSidebar();
  else if (tabId !== undefined) await api.openSidePanel?.(tabId);
}

/** The keyboard shortcut: opens whatever the toolbar button opens. */
export async function openSurface(
  api: SurfaceApi,
  surface: Surface,
  tabId: number | undefined,
): Promise<void> {
  if (surface === 'popup') await api.openPopup?.();
  else await onActionClicked(api, tabId);
}
