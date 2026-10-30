import { describe, expect, it } from 'vitest';
import { defaultSettings } from './schema';
import { targetFor } from './routing';

describe('targetFor', () => {
  const settings = {
    ...defaultSettings(),
    activeTargetId: 'local',
    targets: [
      ...defaultSettings().targets,
      { id: 'home', kind: 'remote' as const, name: 'Home', url: 'https://dlm.example.test' },
    ],
    routes: [
      { site: 'example.test', targetId: 'home' },
      { site: 'cdn.example.test', targetId: 'local' },
    ],
  };

  it('uses the longest matching site, and the default target otherwise', () => {
    expect(targetFor(settings, 'https://files.example.test/a.zip')).toBe('home');
    expect(targetFor(settings, 'https://cdn.example.test/a.zip')).toBe('local');
    expect(targetFor(settings, 'https://other.test/a.zip')).toBe('local');
    expect(targetFor(settings, 'magnet:?xt=urn:btih:abc')).toBe('local');
  });

  it('ignores a route whose target was removed', () => {
    expect(
      targetFor(
        { ...settings, routes: [{ site: 'example.test', targetId: 'gone' }] },
        'https://example.test/a',
      ),
    ).toBe('local');
  });
});
