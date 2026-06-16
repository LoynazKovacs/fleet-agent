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
  /**
   * Stage-3 networking master switch (default OFF). When false the agent does
   * NOTHING with Docker networks or Tailscale — so a plain deploy can never
   * auto-start Tailscale. Turn on per node only when bringing up the tailnet.
   */
  netEnabled: boolean;
  /** This node's Tailscale auth key (bootstrap secret, single-use). Set ONLY for
   * the LEGACY standalone subnet-router path; the canonical node leaves it unset
   * and advertises in place from its shared-netns uplink. */
  tsAuthKey: string;
  /** Tailscale node hostname; defaults to the agent `name`. */
  tsHostname: string;
  /**
   * Name of the shared-netns Tailscale UPLINK container the agent advertises the
   * fleet subnet from (in place, via `tailscale set`). The agent shares this
   * container's network namespace, so its control-plane polling rides the
   * uplink's default route — independent of fleet-net. Default `fleet-tailscale`.
   */
  uplinkContainerName: string;
  /**
   * Extra subnet routes this node must advertise IN ADDITION to its fleet /24,
   * comma-separated. For a co-located master node this is the legacy core docker
   * net it fronts (e.g. `172.18.0.0/16`) so other nodes keep reaching the master
   * core while the node also advertises its fleet-net. Advertised as a UNION with
   * the assigned subnet — `--advertise-routes` replaces, so the agent must always
   * send the full set. The control plane may also supply extra routes per poll;
   * the two are merged. Empty by default (a plain node advertises only its /24).
   */
  extraRoutes: string[];
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

function flagBool(name: string, env: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(flag(name, env, ''));
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
    netEnabled: flagBool('net-enabled', process.env.FLEET_NET_ENABLED),
    tsAuthKey: flag('ts-authkey', process.env.FLEET_TS_AUTHKEY),
    tsHostname: flag('ts-hostname', process.env.FLEET_TS_HOSTNAME, name),
    uplinkContainerName: flag('uplink-container', process.env.FLEET_UPLINK_CONTAINER, 'fleet-tailscale'),
    extraRoutes: parseRoutes(flag('extra-routes', process.env.FLEET_EXTRA_ROUTES, '')),
  };
}

/** Split a comma/space-separated routes string into a clean, deduped list. */
function parseRoutes(raw: string): string[] {
  return [...new Set(raw.split(/[,\s]+/).map((r) => r.trim()).filter(Boolean))];
}
