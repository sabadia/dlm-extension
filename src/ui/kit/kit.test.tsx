import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { ChipInput, Dialog, Menu, Segmented, Switch, useToasts } from './index';

const root = () => {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
};
const mount = async (node: preact.VNode) => {
  const el = root();
  await act(() => render(node, el));
  return el;
};
const click = (el: Element | null | undefined) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
const key = (el: Element | null | undefined, k: string) =>
  act(() => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Menu', () => {
  const items = (picked: string[]) => [
    { label: 'One', onSelect: () => picked.push('one') },
    { label: 'Two', onSelect: () => picked.push('two'), disabled: true },
    { label: 'Three', onSelect: () => picked.push('three'), separated: true },
  ];

  it('opens on click, names its button, moves with arrow keys, skips disabled items, and chooses', async () => {
    const picked: string[] = [];
    const el = await mount(<Menu label="More" items={items(picked)} />);
    const button = el.querySelector('button[aria-label="More"]');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    await click(button);
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    const entries = [...el.querySelectorAll('[role="menuitem"]')];
    expect(entries.map((entry) => entry.textContent)).toEqual(['One', 'Two', 'Three']);
    expect(document.activeElement).toBe(entries[0]);
    await key(el.querySelector('.menu-wrap'), 'ArrowDown');
    expect(document.activeElement).toBe(entries[2]); // Two is disabled
    await click(entries[2]);
    expect(picked).toEqual(['three']);
    expect(el.querySelector('[role="menu"]')).toBeNull();
  });

  it('closes with Escape and gives focus back to its button', async () => {
    const el = await mount(<Menu label="More" items={items([])} />);
    const button = el.querySelector('button[aria-label="More"]') as HTMLElement;
    await click(button);
    await key(el.querySelector('.menu-wrap'), 'Escape');
    expect(el.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe('ChipInput', () => {
  function Harness({ start = [] as string[] }: { start?: string[] }) {
    return (
      <ChipInput
        values={start}
        onChange={(values) => (seen.push(values), undefined)}
        normalize={(v) => (/^[a-z.]+$/.test(v) ? v : undefined)}
        label="Sites"
      />
    );
  }
  const seen: string[][] = [];
  afterEach(() => (seen.length = 0));

  const type = (el: HTMLInputElement, value: string) =>
    act(() => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

  it('adds on Enter, comma and blur, keeps duplicates out, and reports what it refuses', async () => {
    const el = await mount(<Harness start={['a.test']} />);
    const input = el.querySelector('input') as HTMLInputElement;
    await type(input, 'b.test');
    await key(input, 'Enter');
    expect(seen.at(-1)).toEqual(['a.test', 'b.test']);
    await type(input, 'c.test, ');
    expect(seen.at(-1)).toEqual(['a.test', 'c.test']);
    await type(input, 'a.test');
    await act(() => {
      input.dispatchEvent(new FocusEvent('blur'));
    });
    expect(seen).toHaveLength(2); // a.test is already there: no change
    await type(input, 'Not Valid!');
    await key(input, 'Enter');
    expect(el.querySelector('.error')?.textContent).toContain('Not');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('removes a chip with its button and the last one with Backspace', async () => {
    const el = await mount(<Harness start={['a.test', 'b.test']} />);
    await click(el.querySelector('.tag button'));
    expect(seen.at(-1)).toEqual(['b.test']);
    await key(el.querySelector('input'), 'Backspace');
    expect(seen.at(-1)).toEqual(['a.test']);
  });
});

describe('Switch, Segmented and Dialog', () => {
  it('a switch is a labelled checkbox with the switch role', async () => {
    const changes: boolean[] = [];
    const el = await mount(
      <Switch checked={false} onChange={(v) => changes.push(v)}>
        Turn on
      </Switch>,
    );
    const input = el.querySelector('input[role="switch"]') as HTMLInputElement;
    expect(el.textContent).toContain('Turn on');
    await act(() => {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(changes).toEqual([true]);
  });

  it('a segmented control marks the chosen option', async () => {
    const chosen: string[] = [];
    const el = await mount(
      <Segmented
        label="Name"
        value="a"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
        onChange={(v) => chosen.push(v)}
      />,
    );
    const [a, b] = [...el.querySelectorAll('button')];
    expect(a?.getAttribute('aria-pressed')).toBe('true');
    expect(b?.getAttribute('aria-pressed')).toBe('false');
    await click(b);
    expect(chosen).toEqual(['b']);
  });

  it('a dialog is modal, focuses its confirm button, and cancels with Escape', async () => {
    const calls: string[] = [];
    const el = await mount(
      <Dialog
        title="Send cookies?"
        confirmLabel="Send"
        cancelLabel="Cancel"
        onConfirm={() => calls.push('ok')}
        onCancel={() => calls.push('no')}
      >
        <p>12 cookies</p>
      </Dialog>,
    );
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Send');
    await key(el.querySelector('.scrim'), 'Escape');
    await click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Send'));
    expect(calls).toEqual(['no', 'ok']);
  });
});

describe('useToasts', () => {
  it('shows a message and removes it later', async () => {
    let show: (text: string) => void = () => undefined;
    function Host() {
      const toasts = useToasts(5);
      show = (text) => toasts.show(text);
      return toasts.host;
    }
    const el = await mount(<Host />);
    await act(() => show('Saved'));
    expect(el.textContent).toContain('Saved');
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    expect(el.textContent).not.toContain('Saved');
  });
});
