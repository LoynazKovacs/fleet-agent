import type { PollRequest, PollResponse } from './protocol.js';

export interface PollCredentials {
  /** Shared bootstrap join key (used until a per-node token is issued). */
  joinKey: string;
  /** This node's own token, once the control plane has issued it. */
  nodeToken: string;
}

/** POST a poll to the control plane. Throws on network / non-2xx. */
export async function poll(coreUrl: string, creds: PollCredentials, body: PollRequest): Promise<PollResponse> {
  // Present the per-node token (primary auth) and, during migration / first
  // enrollment, the shared join key as a fallback. The control plane prefers
  // the token and only falls back to the join key per its policy.
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (creds.nodeToken) headers['x-fleet-node-token'] = creds.nodeToken;
  if (creds.joinKey) headers['x-fleet-join-key'] = creds.joinKey;

  const res = await fetch(`${coreUrl}/agent/poll`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`poll ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as PollResponse;
}
