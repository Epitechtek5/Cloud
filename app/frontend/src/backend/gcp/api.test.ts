import { describe, expect, it, vi } from 'vitest';
import { createGatewayApi } from './api';

const mk = (res: Response | (() => Promise<Response>)) => {
  const f = vi.fn(async () => (typeof res === 'function' ? res() : res));
  const api = createGatewayApi({ apiBase: 'https://gw/v1', token: async () => 'jwt', fetch: f as unknown as typeof fetch, newCorrelationId: () => 'cid' });
  return { f, api };
};
const info = { x: 10, y: 20, color: 0xff0000, author: '42', authorName: 'alice', ts: 1234 };

describe('draw', () => {
  it('posts the batch with the JWT and a correlation id, and accepts a 202', async () => {
    const { f, api } = mk(new Response(null, { status: 202 }));
    await api.draw([{ x: 1, y: 2, color: 3 }], 'b1');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gw/v1/pixels');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer jwt', 'X-Correlation-Id': 'cid', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ batchId: 'b1', pixels: [{ x: 1, y: 2, color: 3 }] });
  });

  it.each([200, 400, 401, 501])('rejects HTTP %i so the optimistic pixels are rolled back', async (status) => {
    await expect(mk(new Response(null, { status })).api.draw([], 'b')).rejects.toThrow(`HTTP ${status}`);
  });

  it('does not call the gateway when the session expired', async () => {
    const f = vi.fn();
    const api = createGatewayApi({ apiBase: 'https://gw', token: async () => Promise.reject(new Error('login_required')), fetch: f });
    await expect(api.draw([], 'b')).rejects.toThrow('login_required');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('pixelInfo', () => {
  it('reads a pixel', async () => {
    const { f, api } = mk(new Response(JSON.stringify(info)));
    expect(await api.pixelInfo(10, 20)).toEqual(info);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gw/v1/pixels/10/20');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
    expect(init.body).toBeUndefined();
  });

  it('returns null for a pixel never painted', async () => {
    expect(await mk(new Response(null, { status: 404 })).api.pixelInfo(1, 1)).toBeNull();
  });

  it('fails on server errors and malformed bodies', async () => {
    await expect(mk(new Response(null, { status: 500 })).api.pixelInfo(1, 1)).rejects.toThrow('HTTP 500');
    await expect(mk(new Response(JSON.stringify({ ...info, ts: 'x' }))).api.pixelInfo(1, 1)).rejects.toThrow(/Unexpected response/);
    await expect(mk(new Response('<html>')).api.pixelInfo(1, 1)).rejects.toThrow(/Unexpected response/);
  });

  it('refuses coordinates outside the grid without a request', async () => {
    const { f, api } = mk(new Response(null, { status: 404 }));
    await expect(api.pixelInfo(100_000, 0)).rejects.toThrow(/outside the grid/);
    await expect(api.pixelInfo(-1, 0)).rejects.toThrow(/outside the grid/);
    expect(f).not.toHaveBeenCalled();
  });
});
