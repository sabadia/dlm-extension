import { describe, expect, it } from 'vitest';
import { browserArea, memoryArea } from './area';

describe('browserArea', () => {
  it('reads, writes and removes one key of a browser storage area', async () => {
    const data: Record<string, unknown> = {};
    const area = browserArea({
      get: (key) => Promise.resolve(key in data ? { [key]: data[key] } : {}),
      set: (items) => {
        Object.assign(data, items);
        return Promise.resolve();
      },
      remove: (key) => {
        delete data[key];
        return Promise.resolve();
      },
    });
    expect(await area.get('a')).toBeUndefined();
    await area.set('a', { n: 1 });
    expect(await area.get('a')).toEqual({ n: 1 });
    await area.remove('a');
    expect(await area.get('a')).toBeUndefined();
  });
});

describe('memoryArea', () => {
  it('keeps copies, so a stored value is not changed by later edits of the original', async () => {
    const area = memoryArea({ start: [1] });
    expect(await area.get('start')).toEqual([1]);
    const list = [1, 2];
    await area.set('list', list);
    list.push(3);
    expect(await area.get('list')).toEqual([1, 2]);
    await area.remove('list');
    expect(await area.get('list')).toBeUndefined();
  });
});
