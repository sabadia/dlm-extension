import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from '../../src/lib/connection/state';
import { Onboarding, type OnboardingApi } from './Onboarding';

function fakeApi(over: Partial<OnboardingApi> & { kinds?: ConnectionState['kind'][] } = {}) {
  const kinds = over.kinds ?? ['app-not-running'];
  let index = 0;
  const calls = { refresh: 0, request: 0, test: 0 };
  const api: OnboardingApi = {
    connection: () => Promise.resolve(kinds[0] ?? 'checking'),
    refresh: () => {
      calls.refresh += 1;
      index = Math.min(index + 1, kinds.length - 1);
      return Promise.resolve(kinds[index] ?? 'checking');
    },
    hasSiteAccess: () => Promise.resolve(true),
    requestSiteAccess: () => {
      calls.request += 1;
      return Promise.resolve(true);
    },
    sendTest: () => {
      calls.test += 1;
      return Promise.resolve({ ok: true });
    },
    ...over,
  };
  return { api, calls };
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function mount(api: OnboardingApi) {
  const root = document.createElement('div');
  document.body.append(root);
  await act(() => render(<Onboarding api={api} />, root));
  await flush();
  return root;
}

const steps = (root: HTMLElement) =>
  [...root.querySelectorAll('li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim());

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('Onboarding', () => {
  it('says what is left to do, with a link to the app and the note about the system permission', async () => {
    const root = await mount(fakeApi({ kinds: ['app-not-running'] }).api);
    const list = steps(root);
    expect(list[0]).toContain('To do:');
    expect(list[0]).toContain('Install the DLM app');
    expect(root.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/sabadia/dlm-app/releases/latest',
    );
    expect(root.textContent).toContain('first connection may wait for a permission');
  });

  it('marks finished steps for a screen reader as well, not only with a tick', async () => {
    const root = await mount(fakeApi({ kinds: ['connected'] }).api);
    expect(steps(root).every((item) => item?.includes('Done:'))).toBe(true);
  });

  it('checks again by itself, so a step finished in the app shows up without a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, calls } = fakeApi({
      kinds: ['app-not-running', 'app-not-running', 'host-not-installed', 'connected'],
    });
    const root = await mount(api);
    expect(steps(root)[0]).toContain('To do:');
    const before = calls.refresh;
    await act(() => {
      vi.advanceTimersByTime(3100);
    });
    await flush();
    await act(() => {
      vi.advanceTimersByTime(3100);
    });
    await flush();
    expect(calls.refresh).toBeGreaterThan(before);
    expect(steps(root).every((item) => item?.includes('Done:'))).toBe(true);
  });

  it('asks the browser for access to every site from a button, when that is what is missing', async () => {
    const { api, calls } = fakeApi({
      kinds: ['connected'],
      hasSiteAccess: () => Promise.resolve(false),
    });
    const root = await mount(api);
    const button = [...root.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Allow access'),
    );
    expect(button).toBeDefined();
    await act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(calls.request).toBe(1);
  });

  it('sends the test download only when connected, and reports the result', async () => {
    const away = await mount(fakeApi({ kinds: ['app-not-running'] }).api);
    expect(
      [...away.querySelectorAll('button')].some((b) => b.textContent?.includes('test download')),
    ).toBe(false);
    document.body.innerHTML = '';
    const { api, calls } = fakeApi({ kinds: ['connected'] });
    const root = await mount(api);
    const button = [...root.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('test download'),
    );
    await act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(calls.test).toBe(1);
    expect(root.querySelector('[role="status"]')?.textContent).toContain('DLM is ready.');
  });

  it('shows why a test download failed', async () => {
    const { api } = fakeApi({
      kinds: ['connected'],
      sendTest: () => Promise.resolve({ ok: false, error: 'The daemon refused it.' }),
    });
    const root = await mount(api);
    const button = [...root.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('test download'),
    );
    await act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(root.querySelector('[role="status"]')?.textContent).toContain('The daemon refused it.');
  });
});
