import { expect, test, type Pairing } from '../support/fixtures';

test.describe('pairing with the DLM on this computer', () => {
  test('is approved in the app and the extension is then connected', async ({
    daemon,
    extension,
    until,
  }) => {
    const started = await extension.send('pairing.start');
    expect(started.phase).toBe('pending');
    const code = started.phase === 'pending' ? started.code : '';
    expect(code).toMatch(/^\d{6}$/);

    const pending = await until('the pairing in the daemon', async () => {
      const list = await daemon.api<Pairing[] | { pairings: Pairing[] }>('GET', '/v1/pairing');
      const all = Array.isArray(list) ? list : list.pairings;
      return all.find((item) => item.code === code);
    });
    // The code the person compares is the same in the app and in the extension.
    expect(pending.code).toBe(code);
    await daemon.api('POST', `/v1/pairing/${pending.id}/approve`);

    await until('an approved pairing', async () => {
      const view = await extension.send('pairing.poll');
      return view.phase === 'approved' || false;
    });
    await until('a connection', async () => {
      const { state } = await extension.send('connection.refresh');
      return state.kind === 'connected' || false;
    });
    expect((await extension.send('downloads.test')).ok).toBe(true);
  });

  test('is refused in the app and the extension says so', async ({ daemon, extension, until }) => {
    const started = await extension.send('pairing.start');
    const code = started.phase === 'pending' ? started.code : '';
    const pending = await until('the pairing in the daemon', async () => {
      const list = await daemon.api<Pairing[] | { pairings: Pairing[] }>('GET', '/v1/pairing');
      const all = Array.isArray(list) ? list : list.pairings;
      return all.find((item) => item.code === code);
    });
    await daemon.api('POST', `/v1/pairing/${pending.id}/deny`);
    await until('a refused pairing', async () => {
      const view = await extension.send('pairing.poll');
      return view.phase === 'denied' || false;
    });
    const { state } = await extension.send('connection.refresh');
    expect(state.kind).not.toBe('connected');
  });

  test('stops working when the token is revoked, and says so', async ({
    daemon,
    extension,
    until,
  }) => {
    const started = await extension.send('pairing.start');
    const code = started.phase === 'pending' ? started.code : '';
    const pending = await until('the pairing in the daemon', async () => {
      const list = await daemon.api<Pairing[] | { pairings: Pairing[] }>('GET', '/v1/pairing');
      const all = Array.isArray(list) ? list : list.pairings;
      return all.find((item) => item.code === code);
    });
    await daemon.api('POST', `/v1/pairing/${pending.id}/approve`);
    await until('an approved pairing', async () => {
      const view = await extension.send('pairing.poll');
      return view.phase === 'approved' || false;
    });
    await until('a connection', async () => {
      const { state } = await extension.send('connection.refresh');
      return state.kind === 'connected' || false;
    });

    const tokens = await daemon.api<
      { id: string; scope?: string }[] | { tokens: { id: string; scope?: string }[] }
    >('GET', '/v1/auth/tokens');
    const list = Array.isArray(tokens) ? tokens : tokens.tokens;
    const issued = list.find((token) => token.scope === 'extension');
    expect(issued).toBeDefined();
    await daemon.api('DELETE', `/v1/auth/tokens/${issued?.id}`);

    const state = await until('the revoked token to be noticed', async () => {
      const next = await extension.send('connection.refresh');
      return next.state.kind === 'token-revoked' ? next.state : false;
    });
    expect(state.kind).toBe('token-revoked');
  });
});
