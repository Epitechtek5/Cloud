import { GRID_SIZE, type Api, type DrawPixel, type PixelInfo } from '../../contract';

export interface GatewayDeps {
  /** API Gateway base URL without trailing slash (RuntimeConfig.apiBase). */
  apiBase: string;
  /** Bearer for the gateway; throws `login_required` once the session expired. */
  token: () => Promise<string>;
  fetch: typeof fetch;
  newCorrelationId?: () => string;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Calls through the API Gateway (docs/frontend-contract.md section 1). Every request carries the
 * session JWT and a fresh `X-Correlation-Id`, which the proxy copies into its logs and the event.
 */
export function createGatewayApi(d: GatewayDeps): Api {
  const correlationId = d.newCorrelationId ?? (() => crypto.randomUUID());

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await d.token()}`,
      'X-Correlation-Id': correlationId(),
      ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
    };
    return d.fetch(`${d.apiBase}${path}`, { ...init, headers });
  }

  return {
    async draw(pixels: DrawPixel[], batchId: string): Promise<void> {
      const res = await call('/pixels', { method: 'POST', body: JSON.stringify({ batchId, pixels }) });
      // 202 = accepted by the proxy; the outcome (drawn, rate limited, paused) comes back through Firestore.
      if (res.status !== 202) throw new Error(`POST /pixels failed (HTTP ${res.status})`);
    },

    async pixelInfo(x: number, y: number): Promise<PixelInfo | null> {
      if (!isInt(x) || !isInt(y) || x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) {
        throw new Error(`Pixel (${x}, ${y}) is outside the grid`);
      }
      const res = await call(`/pixels/${x}/${y}`);
      if (res.status === 404) return null; // never painted
      if (!res.ok) throw new Error(`GET /pixels/${x}/${y} failed (HTTP ${res.status})`);
      const b = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!b || !isInt(b.x) || !isInt(b.y) || !isInt(b.color) || typeof b.author !== 'string' || typeof b.authorName !== 'string' || typeof b.ts !== 'number') {
        throw new Error('Unexpected response from GET /pixels');
      }
      return { x: b.x, y: b.y, color: b.color, author: b.author, authorName: b.authorName, ts: b.ts };
    },
  };
}
