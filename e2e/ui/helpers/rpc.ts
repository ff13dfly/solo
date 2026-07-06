import { Page, expect } from '@playwright/test';

/**
 * RPC-call recorder — the septopus `serverHits` pattern adapted to SOLO's portals.
 *
 * Septopus asserts on which game-server calls actually left the client (and that a
 * non-whitelisted method was refused before any fetch). SOLO's analogue: observe every
 * JSON-RPC request the portal sends to the Router and assert on the SET of methods —
 * "the authenticated dashboard emits exactly these calls", or, tied to the public-method
 * convergence work, "an anonymous surface never emits a privileged/non-public method".
 *
 * It OBSERVES (page.on('request')) rather than intercepting, so the real Router still
 * answers — these assertions layer on top of the existing real-mesh smoke tests without
 * changing their behaviour. Match is by Router ORIGIN (host:port), so portal asset
 * requests to the vite dev server (:9200/:9300) are ignored.
 */
export interface RpcCall {
  method: string;
  params: unknown;
  hadAuth: boolean;   // did the request carry an Authorization: Bearer header?
}

export interface RpcRecorder {
  readonly calls: RpcCall[];
  methods(): string[];
  sent(method: string): boolean;
  count(method: string): number;
  assertSent(method: string): void;
  assertNotSent(method: string): void;
  assertNoneSent(methods: string[]): void;
  clear(): void;
}

const routerOrigin = new URL(process.env.SOLO_ROUTER_URL || 'http://localhost:8600').origin;

export function recordRpc(page: Page): RpcRecorder {
  const calls: RpcCall[] = [];

  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    let origin: string;
    try { origin = new URL(req.url()).origin; } catch { return; }
    if (origin !== routerOrigin) return;   // only the Router JSON-RPC endpoint

    let body: any;
    try { body = req.postDataJSON(); } catch { return; }
    // JSON-RPC may batch (array) or be a single object.
    const frames = Array.isArray(body) ? body : [body];
    for (const f of frames) {
      if (!f || typeof f.method !== 'string') continue;
      const auth = req.headers()['authorization'] || '';
      calls.push({ method: f.method, params: f.params, hadAuth: /^Bearer\s+\S/i.test(auth) });
    }
  });

  const methods = () => calls.map((c) => c.method);
  return {
    calls,
    methods,
    sent: (m) => calls.some((c) => c.method === m),
    count: (m) => calls.filter((c) => c.method === m).length,
    assertSent(m) {
      expect(methods(), `expected the portal to have sent RPC "${m}"`).toContain(m);
    },
    assertNotSent(m) {
      expect(methods(), `expected the portal NOT to have sent RPC "${m}"`).not.toContain(m);
    },
    assertNoneSent(denied) {
      const leaked = methods().filter((m) => denied.includes(m));
      expect(leaked, `privileged/non-public RPC leaked from this surface: ${leaked.join(', ')}`).toEqual([]);
    },
    clear() { calls.length = 0; },
  };
}
