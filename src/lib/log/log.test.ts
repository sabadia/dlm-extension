import { describe, expect, it } from 'vitest';
import { memoryArea } from '../storage/area';
import { buildDiagnostics } from './diagnostics';
import { LOG_KEY, RingLog } from './log';

const now = () => Date.UTC(2026, 9, 30, 12);

describe('RingLog', () => {
  it('keeps redacted entries, oldest first', async () => {
    const log = new RingLog(memoryArea(), { now });
    log.info('native', 'got token dlmt_AbCdEf0123456789xyz', { cookie: 'a=b', port: 5 });
    log.warn('client', 'slow');
    const entries = await log.read();
    expect(entries.map((e) => e.message)).toEqual(['got token ***', 'slow']);
    expect(entries[0]?.fields).toEqual({ cookie: '***', port: 5 });
  });

  it('drops the oldest beyond its capacity', async () => {
    const log = new RingLog(memoryArea(), { capacity: 3, now });
    for (let i = 0; i < 5; i++) log.info('t', `m${i}`);
    expect((await log.read()).map((e) => e.message)).toEqual(['m2', 'm3', 'm4']);
  });

  it('ignores levels below the minimum', async () => {
    const log = new RingLog(memoryArea(), { now });
    log.debug('t', 'noise');
    log.error('t', 'real');
    expect((await log.read()).map((e) => e.message)).toEqual(['real']);
  });

  it('survives a restart: a new log reads what the area holds', async () => {
    const area = memoryArea();
    const first = new RingLog(area, { now });
    first.info('t', 'before');
    await first.read(); // the write has landed
    const again = new RingLog(area, { now });
    expect((await again.read()).map((e) => e.message)).toEqual(['before']);
    await again.clear();
    expect(await area.get(LOG_KEY)).toBeUndefined();
  });

  it('never throws when the storage does', async () => {
    const broken = {
      get: () => Promise.reject(new Error('no')),
      set: () => Promise.reject(new Error('no')),
      remove: () => Promise.reject(new Error('no')),
    };
    const log = new RingLog(broken, { now });
    log.info('t', 'x');
    expect(await log.read()).toHaveLength(1);
  });
});

describe('buildDiagnostics', () => {
  it('holds no secret, whatever is passed in', async () => {
    const log = new RingLog(memoryArea(), { now });
    log.info('pairing', 'token dlmt_AbCdEf0123456789xyz stored for https://u:p@h.test/?token=abc');
    const text = buildDiagnostics({
      version: '0.1.0',
      userAgent: 'Mozilla/5.0',
      state: { connection: 'connected', token: 'dlmt_AbCdEf0123456789xyz' },
      settings: {
        targets: [{ url: 'https://h.test', token: 'dlmt_AbCdEf0123456789xyz', name: 'home' }],
      },
      log: await log.read(),
    });
    expect(text).toContain('DLM extension 0.1.0');
    expect(text).toContain('connected');
    expect(text).toContain('home');
    expect(text).not.toMatch(/dlmt_/);
    expect(text).not.toContain('u:p@');
    expect(text).not.toContain('token=abc');
  });
});
