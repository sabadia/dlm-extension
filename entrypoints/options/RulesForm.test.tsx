import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, type Settings, type SettingsPatch } from '../../src/lib/settings/schema';
import { RulesForm, type SettingsApi } from './RulesForm';

const targets = [
  { id: 'local', name: 'DLM on this computer' },
  { id: 'home', name: 'Home' },
];

function fakeApi(over: Partial<SettingsApi> = {}) {
  const saved: SettingsPatch[] = [];
  const api: SettingsApi = {
    load: () => Promise.resolve({ settings: defaultSettings(), targets }),
    save: (patch) => {
      saved.push(patch);
      const base = defaultSettings();
      return Promise.resolve<Settings>({
        ...base,
        rules: patch.rules,
        preferences: patch.preferences,
        routes: patch.routes,
      });
    },
    exportText: () => Promise.resolve('{"version":4}'),
    importText: () => Promise.reject(new Error('That file is not JSON.')),
    ...over,
  };
  return { api, saved };
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function mount(
  api: SettingsApi,
  saveFile: (name: string, text: string) => void = () => undefined,
) {
  const root = document.createElement('div');
  document.body.append(root);
  await act(() => render(<RulesForm api={api} saveFile={saveFile} />, root));
  await settle();
  return root;
}

const field = (root: HTMLElement, label: string) => {
  const found = [...root.querySelectorAll('label')].find((item) =>
    item.textContent?.includes(label),
  );
  const control = found?.querySelector('textarea, input, select');
  if (!control) throw new Error(`no field ${label}`);
  return control as HTMLInputElement | HTMLTextAreaElement;
};
const button = (root: HTMLElement, label: string) => {
  const found = [...root.querySelectorAll('button')].find((item) =>
    (item.textContent || item.getAttribute('aria-label') || '').includes(label),
  );
  if (!found) throw new Error(`no button ${label}`);
  return found;
};
const chips = (root: HTMLElement, label: string) =>
  root.querySelector(`.chip-input input[aria-label="${label}"]`) as HTMLInputElement;
const enter = (control: HTMLElement) =>
  act(() => {
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
async function type(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(() => {
    control.value = value;
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = (element: Element) =>
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

afterEach(() => {
  document.body.innerHTML = '';
});

describe('RulesForm', () => {
  it('adds sites as chips, one by Enter and several separated by commas, and saves them', async () => {
    const { api, saved } = fakeApi();
    const root = await mount(api);
    const sites = chips(root, 'Sites to leave in the browser');
    await type(sites, 'example.com');
    await enter(sites);
    await type(sites, 'Other.test, third.test');
    await enter(sites);
    expect([...root.querySelectorAll('.tag')].map((tag) => tag.textContent)).toEqual([
      'example.com',
      'other.test',
      'third.test',
    ]);
    await click(button(root, 'Save'));
    await settle();
    expect(saved[0]?.rules.excludedSites).toEqual(['example.com', 'other.test', 'third.test']);
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Saved.');
  });

  it('lets a second extension be typed after a comma', async () => {
    const { api, saved } = fakeApi();
    const root = await mount(api);
    const types = chips(root, 'Only these extensions');
    await type(types, 'zip,');
    await type(types, 'iso');
    await enter(types);
    await click(button(root, 'Save'));
    await settle();
    expect(saved[0]?.rules.fileTypes).toEqual(['zip', 'iso']);
  });

  it('refuses a site that is not valid, shows it, and removes a chip', async () => {
    const { api, saved } = fakeApi();
    const root = await mount(api);
    const sites = chips(root, 'Sites to always take');
    await type(sites, 'good.test');
    await enter(sites);
    await type(sites, 'not!valid');
    await enter(sites);
    expect(root.textContent).toContain('not!valid');
    expect(sites.getAttribute('aria-invalid')).toBe('true');
    await click(button(root, 'Sites to always take: good.test'));
    await click(button(root, 'Save'));
    await settle();
    expect(saved[0]?.rules.alwaysSites).toEqual([]);
  });

  it('shows what it refuses, marks the field, and saves nothing', async () => {
    const { api, saved } = fakeApi();
    const root = await mount(api);
    const size = field(root, 'Leave files smaller than this');
    await type(size, '');
    await click(button(root, 'Save'));
    await settle();
    expect(saved).toEqual([]);
    expect(size.getAttribute('aria-invalid')).toBe('true');
    expect(root.textContent).toContain('Enter a whole number of bytes');
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Fix the marked fields');
  });

  it('adds a route with a chosen DLM and sends it', async () => {
    const { api, saved } = fakeApi();
    const root = await mount(api);
    await click(button(root, 'Add a site'));
    const site = root.querySelector('input[aria-label="Site"]') as HTMLInputElement;
    const target = root.querySelector('select[aria-label="DLM"]') as HTMLSelectElement;
    await type(site, 'files.example.test');
    await act(() => {
      target.value = 'home';
      target.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(button(root, 'Save'));
    await settle();
    expect(saved[0]?.routes).toEqual([{ site: 'files.example.test', targetId: 'home' }]);
    await click(button(root, 'Remove files.example.test'));
    expect(root.querySelector('input[aria-label="Site"]')).toBeNull();
  });

  it('saves only the rules, preferences, routes and files settings, never the targets', async () => {
    const { api, saved } = fakeApi();
    const root = await mount(api);
    await click(button(root, 'Save'));
    await settle();
    // `base` is the settings as the form loaded them, so that only what the person changed is applied.
    expect(Object.keys(saved[0] ?? {}).sort()).toEqual([
      'base',
      'files',
      'preferences',
      'routes',
      'rules',
    ]);
  });

  it('says why a save failed, and keeps what was typed', async () => {
    const { api } = fakeApi({ save: () => Promise.reject(new Error('The daemon said no.')) });
    const root = await mount(api);
    const sites = chips(root, 'Sites to leave in the browser');
    await type(sites, 'example.com');
    await enter(sites);
    await click(button(root, 'Save'));
    await settle();
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      'Could not save: The daemon said no.',
    );
    expect(root.querySelector('.tag')?.textContent).toBe('example.com');
  });

  it('gives the settings as a file', async () => {
    const files: { name: string; text: string }[] = [];
    const root = await mount(fakeApi().api, (name, text) => files.push({ name, text }));
    await click(button(root, 'Export settings'));
    await settle();
    expect(files).toEqual([{ name: 'dlm-settings.json', text: '{"version":4}' }]);
    expect(root.textContent).toContain('Settings saved as a file.');
  });

  it('turns the expired-link switch on and off', async () => {
    const { api, saved } = fakeApi();
    const root = await mount(api);
    const box = field(root, 'Look for expired links');
    expect((box as HTMLInputElement).checked).toBe(true);
    await act(() => {
      (box as HTMLInputElement).checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(button(root, 'Save'));
    await settle();
    expect(saved[0]?.preferences.refresh).toBe(false);
  });
});
