import { describe, expect, it } from 'vitest';
import { ApiError, extensionOrigin, problemFrom } from './errors';

function problem(status: number, detail: string): Response {
  return new Response(JSON.stringify({ status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

describe('problemFrom', () => {
  it('keeps what the daemon says', async () => {
    const error = await problemFrom(problem(404, 'task not found'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('task not found');
  });

  it('tells a refused browser address which address to allow', async () => {
    const error = await problemFrom(problem(403, 'cross-origin request rejected'));
    expect(error.status).toBe(403);
    expect(error.message).toContain('Allowed origins');
    expect(error.message).toContain(extensionOrigin());
  });

  it('does not touch another 403', async () => {
    const error = await problemFrom(problem(403, 'this token is read-only'));
    expect(error.message).toBe('this token is read-only');
  });
});
