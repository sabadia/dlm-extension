import { describe, expect, it } from 'vitest';
import { applySurface, onActionClicked, openSurface, POPUP_PATH, type SurfaceApi } from './surface';

function api(parts: Partial<SurfaceApi> = {}) {
  const calls: string[] = [];
  const full: SurfaceApi = {
    setPopup: (popup) => void calls.push(`popup:${popup}`),
    ...parts,
  };
  return { api: full, calls };
}

describe('applySurface', () => {
  it('panel: no popup, and Chrome opens the panel by itself', async () => {
    const { api: a, calls } = api({
      openPanelOnActionClick: (on) => void calls.push(`panel:${on}`),
    });
    await applySurface(a, 'panel');
    expect(calls).toEqual(['popup:', 'panel:true']);
  });

  it('popup: the popup page, and the panel does not open on a click', async () => {
    const { api: a, calls } = api({
      openPanelOnActionClick: (on) => void calls.push(`panel:${on}`),
    });
    await applySurface(a, 'popup');
    expect(calls).toEqual([`popup:${POPUP_PATH}`, 'panel:false']);
  });

  it('works where there is no side panel API (Firefox)', async () => {
    const { api: a, calls } = api();
    await applySurface(a, 'panel');
    expect(calls).toEqual(['popup:']);
  });
});

describe('opening', () => {
  it('a click on a button with no popup opens the Firefox sidebar, or the Chrome panel of that tab', async () => {
    const firefox = api({ openSidebar: () => void firefox.calls.push('sidebar') });
    await onActionClicked(firefox.api, 4);
    expect(firefox.calls).toEqual(['sidebar']);
    const chrome = api({ openSidePanel: (tab) => void chrome.calls.push(`panel:${tab}`) });
    await onActionClicked(chrome.api, 4);
    await onActionClicked(chrome.api, undefined);
    expect(chrome.calls).toEqual(['panel:4']);
  });

  it('the shortcut opens the popup when that is the setting, else the panel', async () => {
    const both = api({
      openPopup: () => void both.calls.push('popup'),
      openSidePanel: (tab) => void both.calls.push(`panel:${tab}`),
    });
    await openSurface(both.api, 'popup', 3);
    await openSurface(both.api, 'panel', 3);
    expect(both.calls).toEqual(['popup', 'panel:3']);
  });
});
