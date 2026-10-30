import { describe, expect, it } from 'vitest';
import { setupSteps } from './setup';

describe('setup steps', () => {
  const done = (kind: Parameters<typeof setupSteps>[0], access = true) =>
    setupSteps(kind, access)
      .map((step) => `${step.id}:${step.done ? 'x' : '-'}`)
      .join(' ');

  it.each([
    ['checking', 'app:- host:- pair:- access:x test:-'],
    ['host-not-installed', 'app:x host:- pair:- access:x test:-'],
    ['app-not-running', 'app:- host:- pair:- access:x test:-'],
    ['needs-pairing', 'app:x host:x pair:- access:x test:-'],
    ['pairing', 'app:x host:x pair:- access:x test:-'],
    ['token-revoked', 'app:x host:x pair:- access:x test:-'],
    ['access-needed', 'app:x host:x pair:- access:- test:-'],
    ['local-unreachable', 'app:x host:x pair:x access:x test:-'],
    ['connected', 'app:x host:x pair:x access:x test:x'],
    // A server added by URL needs no host and no pairing.
    ['remote-needs-token', 'app:x host:x pair:x access:x test:-'],
    ['remote-unreachable', 'app:x host:x pair:x access:x test:-'],
  ] as const)('%s: %s', (kind, expected) => {
    expect(done(kind)).toBe(expected);
  });

  it('wants the permission for every site, which Firefox grants only when asked', () => {
    expect(done('connected', false)).toBe('app:x host:x pair:x access:- test:x');
  });
});
