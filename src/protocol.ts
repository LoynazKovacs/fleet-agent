// Fleet wire protocol — the contract between the control plane and the agent.
//
// KEEP IN SYNC with backend/src/protocol.ts (verbatim copy). This file is the
// only shared shape; both sides build independently so we duplicate it rather
// than introduce a workspace package. It is intentionally generic — it carries
// no platform internals, so the agent image can be published publicly.

export const FLEET_PROTOCOL_VERSION = 1;

/** Snapshot of one container as seen on a node. */
export interface ContainerSnapshot {
  containerId: string;
  name: string;
  image: string;
  stack: string;
  service: string;
  state: string; // created | running | exited | ...
  status: string; // human "Up 3 minutes"
  health: string;
  cpuPercent: number;
  memMB: number;
  memPercent: number;
  ports: string;
  restartCount: number;
  startedAt: string | null;
  uptimeSeconds: number;
}

/** Host facts the agent reports about itself. */
export interface NodeInfo {
  nodeId: string;
  name: string;
  os: string; // linux
  arch: string; // amd64 | arm64
  kernel: string;
  dockerVersion: string;
  agentVersion: string;
  tailnetName?: string;
  tailscaleIp?: string;
}

export type CommandKind =
  | 'run'
  | 'stop'
  | 'start'
  | 'restart'
  | 'remove'
  | 'pull'
  | 'deployApp'
  | 'removeApp';

/**
 * Ephemeral registry credentials for an authenticated image pull, shaped as a
 * dockerode `authconfig`. The control plane resolves these at command DISPATCH
 * time (e.g. a short-lived GCP OAuth token) and attaches them to the in-flight
 * command only — they are never persisted in the command audit log. The agent
 * stays credential-agnostic: it just relays this to the Docker daemon.
 */
export interface RegistryAuth {
  username: string;
  password: string;
  serveraddress: string;
}

/** A single-container run spec (stage 1 — compose stacks come later). */
export interface RunContainerSpec {
  image: string;
  name?: string;
  env?: Record<string, string>;
  ports?: Array<{ host: number; container: number; protocol?: 'tcp' | 'udp' }>;
  volumes?: Array<{ host: string; container: string; readOnly?: boolean }>;
  restart?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  command?: string[];
  network?: string;
  pull?: boolean; // pull image before run (default true)
}

/**
 * One service inside a multi-container app bundle: a single-container run spec
 * plus its bundle wiring. `serviceName` is the service's in-network hostname —
 * siblings resolve each other by it — and its `dependsOn` ordering key. `auth`
 * is this service's pull credential, resolved and attached at command DISPATCH
 * only (exactly like the single-image `Command.auth`); it is never persisted.
 */
export interface BundleServiceSpec extends RunContainerSpec {
  serviceName: string;
  dependsOn?: string[];
  auth?: RegistryAuth;
}

/**
 * A resolved multi-container app bundle deployed as a unit (`deployApp`). Every
 * service joins `networkName` and resolves its siblings by `serviceName`; only
 * the ports in each service's `ports` (its ingress roster) are published to the
 * host. Services are started in `dependsOn` topological order.
 */
export interface BundleSpec {
  appKey: string;
  networkName: string;
  services: BundleServiceSpec[];
}

/** The services + shared network to tear down as a unit (`removeApp`). */
export interface BundleRemoveSpec {
  appKey: string;
  networkName: string;
  containerNames: string[];
}

/** Per-service outcome of a bundle deploy, rolled up onto the deployment row. */
export interface BundleServiceResult {
  serviceName: string;
  containerName: string;
  ok: boolean;
  containerId?: string;
  error?: string;
}

/** A command the control plane wants a node to execute. */
export interface Command {
  id: string;
  kind: CommandKind;
  spec?: RunContainerSpec; // for `run`
  bundle?: BundleSpec; // for `deployApp` — per-service auth attached at dispatch, never persisted
  removeBundle?: BundleRemoveSpec; // for `removeApp`
  target?: string; // container name/id (stop/start/restart/remove) or image ref (pull)
  auth?: RegistryAuth; // ephemeral pull credentials (run/pull); attached at dispatch, never persisted
  createdAt: string;
}

export interface CommandResult {
  id: string;
  ok: boolean;
  detail?: string;
  error?: string;
  services?: BundleServiceResult[]; // per-service breakdown for deployApp/removeApp
  finishedAt: string;
}

/** Agent → control plane, every poll. */
export interface PollRequest {
  protocolVersion: number;
  node: NodeInfo;
  containers: ContainerSnapshot[];
  results: CommandResult[]; // results of commands handed out on previous polls
}

/** Control plane → agent, poll response. */
export interface PollResponse {
  ok: boolean;
  approved: boolean; // node approval state; commands only flow once approved
  commands: Command[];
  pollIntervalMs: number; // server-dictated cadence
  // The node's own long-lived enrollment token, returned exactly ONCE — on the
  // poll where the control plane first issues it. The agent persists it and
  // presents it as `x-fleet-node-token` on every later poll, so it stops
  // depending on the shared bootstrap join key. Absent on all subsequent polls.
  issuedToken?: string;
  // The node's control-plane-assigned fleet network (Stage 3). The agent ensures
  // a Docker network named `network.name` on the unique, non-overlapping
  // `network.subnet`, places app bundles on it, and advertises that subnet to the
  // tailnet via its Tailscale subnet-router — so the node never collides with
  // another node's routes. Acted on only when FLEET_NET_ENABLED is set; absent
  // until the control plane has allocated a subnet.
  network?: { name: string; subnet: string };
}
