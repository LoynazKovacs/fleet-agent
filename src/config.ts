import { hostname } from 'node:os';

export interface AgentConfig {
  /** Base URL of the fleet control plane, e.g. https://host/fleet-api */
  coreUrl: string;
  /** Shared BOOTSTRAP enrollment secret (x-fleet-join-key). Used only until the
   * control plane issues this node its own token; optional once a token is
   * persisted. */
  joinKey: string;
  /** Human label for this node. */
  name: string;
  /** Poll cadence (ms); the server can override this per response. */
  pollIntervalMs: number;
  /** Docker daemon socket. */
  dockerSocketPath: string;
  /** File where the stable node id is persisted across restarts. */
  nodeIdFile: string;
  /** File where the per-node token issued by the control plane is persisted.
   * Empty → derived as a sibling of nodeIdFile (e.g. /data/node-token). */
  nodeTokenFile: string;
  tailnetName: string;
  tailscaleIp: string;
}

/** Read `--key value` flags first, then FLEET_* env, then defaults. */
function flag(name: string, env: string | undefined, fallback = ''): string {
  const argv = process.argv;
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return (env ?? '').trim() || fallback;
}

function flagInt(name: string, env: string | undefined, fallback: number): number {
  const raw = flag(name, env, '');
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getAgentConfig(): AgentConfig {
  const name = flag('name', process.env.FLEET_NODE_NAME, hostname());
  return {
    coreUrl: flag('core-url', process.env.FLEET_CORE_URL).replace(/\/+$/, ''),
    joinKey: flag('join-key', process.env.FLEET_JOIN_KEY),
    name,
    pollIntervalMs: flagInt('poll-interval', process.env.FLEET_POLL_INTERVAL_MS, 5_000),
    dockerSocketPath: flag('docker-socket', process.env.DOCKER_SOCKET_PATH, '/var/run/docker.sock'),
    nodeIdFile: flag('node-id-file', process.env.FLEET_NODE_ID_FILE, '/data/node-id'),
    nodeTokenFile: flag('node-token-file', process.env.FLEET_NODE_TOKEN_FILE),
    tailnetName: flag('tailnet-name', process.env.FLEET_TAILNET_NAME),
    tailscaleIp: flag('tailscale-ip', process.env.FLEET_TAILSCALE_IP),
  };
}
