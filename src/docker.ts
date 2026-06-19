import Docker from 'dockerode';
import type {
  BundleRemoveSpec,
  BundleServiceResult,
  BundleServiceSpec,
  BundleSpec,
  ContainerSnapshot,
  RegistryAuth,
  RunContainerSpec,
} from './protocol.js';

export interface HostInfo {
  os: string;
  arch: string;
  kernel: string;
  dockerVersion: string;
}

export class DockerClient {
  private readonly docker: Docker;

  constructor(socketPath: string) {
    this.docker = new Docker({ socketPath });
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /** Static host facts (os/arch/kernel/docker version) reported on every poll. */
  async hostInfo(): Promise<HostInfo> {
    try {
      const [info, version] = await Promise.all([this.docker.info() as Promise<any>, this.docker.version() as Promise<any>]);
      return {
        os: String(info?.OSType ?? 'linux'),
        arch: normalizeArch(String(info?.Architecture ?? process.arch)),
        kernel: String(info?.KernelVersion ?? ''),
        dockerVersion: String(version?.Version ?? ''),
      };
    } catch {
      return { os: 'linux', arch: normalizeArch(process.arch), kernel: '', dockerVersion: '' };
    }
  }

  /** Sample every container (running + stopped). */
  async sampleContainers(): Promise<ContainerSnapshot[]> {
    const list = await this.docker.listContainers({ all: true });
    return Promise.all(
      list.map(async (info): Promise<ContainerSnapshot> => {
        const name = (info.Names?.[0] ?? info.Id).replace(/^\//, '');
        const labels = info.Labels ?? {};
        const ports = (info.Ports ?? [])
          .filter((p) => p.PublicPort)
          .map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type}`)
          .join(', ');

        const snap: ContainerSnapshot = {
          containerId: info.Id.slice(0, 12),
          name,
          image: info.Image,
          stack: labels['com.docker.compose.project'] ?? '',
          service: labels['com.docker.compose.service'] ?? '',
          state: info.State,
          status: info.Status,
          health: '',
          cpuPercent: 0,
          memMB: 0,
          memPercent: 0,
          ports,
          restartCount: 0,
          startedAt: null,
          uptimeSeconds: 0,
        };

        if (info.State === 'running') {
          try {
            const container = this.docker.getContainer(info.Id);
            const [stats, inspect] = await Promise.all([
              container.stats({ stream: false }) as Promise<any>,
              container.inspect(),
            ]);
            snap.cpuPercent = computeCpuPercent(stats);
            const mem = computeMem(stats);
            snap.memMB = mem.usedMB;
            snap.memPercent = mem.percent;
            snap.restartCount = inspect.RestartCount ?? 0;
            snap.health = inspect.State?.Health?.Status ?? '';
            const startedAt = inspect.State?.StartedAt ?? null;
            if (startedAt && startedAt !== '0001-01-01T00:00:00Z') {
              snap.startedAt = startedAt;
              snap.uptimeSeconds = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
            }
          } catch {
            /* best effort — keep the base snapshot */
          }
        }
        return snap;
      }),
    );
  }

  async pullImage(image: string, auth?: RegistryAuth): Promise<void> {
    // dockerode passes `authconfig` straight to the daemon's X-Registry-Auth
    // header; omit it for anonymous pulls (Docker Hub / public images).
    const stream = await this.docker.pull(image, auth ? { authconfig: auth } : {});
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream as NodeJS.ReadableStream, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Update the agent itself to a newer image — driven from the control plane, so
   * the node never needs its own registry credentials (the whole point of the
   * brokered-auth model; the watchtower sidecar this replaces could not use it).
   *
   * Two steps, because a process cannot recreate its own container (removing it
   * kills this process mid-operation):
   *   1. We pull the new image HERE, with the short-lived token the control plane
   *      attached to the command — the only step that touches the registry.
   *   2. We launch a DETACHED sibling helper that, after a short delay (so we can
   *      ack this command on the current poll first), runs `docker compose up`
   *      for ONLY the `agent` service from the node's repo dir, recreating us
   *      from the just-pulled local image with `--pull never` (no node creds).
   *
   * The helper uses the public `docker:cli` image (compose plugin bundled, no
   * auth) and the host repo path the compose passes us as `FLEET_COMPOSE_DIR`.
   * Returns the helper container id. The real success signal is the node's
   * reported `agentVersion` bumping after the new agent boots.
   */
  async selfUpdate(image: string, auth?: RegistryAuth): Promise<string> {
    if (!image) throw new Error('updateAgent command missing image');

    // Step 1 — authenticated pull of the new agent image (brokered token).
    await this.pullImage(image, auth);

    // Step 2 — recreate via a detached helper. We need the HOST path of the node
    // repo (compose file + .env) to run compose against; the compose passes it in
    // as FLEET_COMPOSE_DIR (`${PWD}` at `docker compose up` time).
    const composeDir = (process.env.FLEET_COMPOSE_DIR ?? '').trim();
    if (!composeDir) {
      throw new Error(
        'FLEET_COMPOSE_DIR not set — agent cannot self-recreate. Update the node compose (adds it + drops the watchtower sidecar) and run `docker compose up -d` once on the node.',
      );
    }

    // The helper image is public — anonymous pull, no node creds.
    await this.pullImage('docker:cli');

    // Recreate ONLY the agent from the already-pulled local image. `--pull never`
    // keeps the registry out of the helper's path entirely; `--force-recreate`
    // guarantees the swap even if compose thinks nothing changed. The leading
    // sleep lets the current poll deliver this command's result before compose
    // stops us. `--no-deps` scopes the recreate to just the agent (the agent
    // shares the uplink's netns; re-evaluating deps is unnecessary). The compose
    // service name is overridable via FLEET_COMPOSE_SERVICE (default `agent`).
    const service = (process.env.FLEET_COMPOSE_SERVICE ?? 'agent').trim() || 'agent';
    const script = `sleep 6; cd "${composeDir}" && docker compose up -d --pull never --force-recreate --no-deps ${service}`;
    const helperName = `fleet-agent-updater-${Date.now().toString(36)}`;
    const helper = await this.docker.createContainer({
      Image: 'docker:cli',
      name: helperName,
      Cmd: ['sh', '-c', script],
      WorkingDir: composeDir,
      HostConfig: {
        AutoRemove: true,
        NetworkMode: 'bridge', // own netns — survives the agent's recreation
        Binds: [
          '/var/run/docker.sock:/var/run/docker.sock',
          `${composeDir}:${composeDir}`,
        ],
      },
    });
    await helper.start();
    return helper.id.slice(0, 12);
  }

  /**
   * Create + start a single container from a run spec. Returns its id.
   *
   * `opts.networkAlias` adds a DNS alias for the container on `spec.network` so a
   * bundle's siblings can reach it by its service name even though its actual
   * container name is the deterministic `<app>-<service>`.
   */
  async runContainer(
    spec: RunContainerSpec,
    auth?: RegistryAuth,
    opts?: { networkAlias?: string; publishHost?: boolean },
  ): Promise<string> {
    if (spec.pull !== false) {
      await this.pullImage(spec.image, auth);
    }

    // Replace an existing container with the same name so deploy is idempotent.
    await this.removeIfExists(spec.name);

    // Host-publish gate: default true (the standalone `run` path keeps publishing).
    // Container ports are always declared (ExposedPorts) so in-network siblings can
    // reach them; host PortBindings are added only when publishHost is set.
    const publishHost = opts?.publishHost ?? true;
    const { exposedPorts, portBindings } = buildPorts(spec.ports, publishHost);
    const binds = (spec.volumes ?? []).map((v) => `${v.host}:${v.container}${v.readOnly ? ':ro' : ''}`);

    const endpointsConfig =
      spec.network && opts?.networkAlias ? { [spec.network]: { Aliases: [opts.networkAlias] } } : undefined;

    const container = await this.docker.createContainer({
      Image: spec.image,
      name: spec.name,
      Cmd: spec.command,
      Env: spec.env ? Object.entries(spec.env).map(([k, v]) => `${k}=${v}`) : undefined,
      ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
      HostConfig: {
        PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
        Binds: binds.length ? binds : undefined,
        NetworkMode: spec.network,
        RestartPolicy: spec.restart && spec.restart !== 'no' ? { Name: spec.restart } : undefined,
      },
      NetworkingConfig: endpointsConfig ? { EndpointsConfig: endpointsConfig } : undefined,
    });
    await container.start();
    return container.id.slice(0, 12);
  }

  /**
   * Run a container that SHARES another container's network namespace
   * (`--network container:<targetId>`). Used to place a service inside its
   * Tailscale sidecar's netns so it inherits the sidecar's tailnet identity +
   * stack-net membership. No own network, no published ports (the sidecar owns
   * the netns and any host port bindings).
   */
  private async runContainerInNetns(spec: RunContainerSpec, targetId: string, auth?: RegistryAuth): Promise<string> {
    if (spec.pull !== false) await this.pullImage(spec.image, auth);
    await this.removeIfExists(spec.name);
    const binds = (spec.volumes ?? []).map((v) => `${v.host}:${v.container}${v.readOnly ? ':ro' : ''}`);
    const container = await this.docker.createContainer({
      Image: spec.image,
      name: spec.name,
      Cmd: spec.command,
      Env: spec.env ? Object.entries(spec.env).map(([k, v]) => `${k}=${v}`) : undefined,
      HostConfig: {
        NetworkMode: `container:${targetId}`,
        Binds: binds.length ? binds : undefined,
        RestartPolicy: spec.restart && spec.restart !== 'no' ? { Name: spec.restart } : undefined,
      },
    });
    await container.start();
    return container.id.slice(0, 12);
  }

  /**
   * Bring up a per-service Tailscale SIDECAR: a `tailscale/tailscale` container
   * (kernel mode) that joins the tailnet with an ephemeral, pre-authorized
   * `tag:fleet` key (minted by the control plane) under a stable MagicDNS
   * `hostname`. The service then runs in this sidecar's netns, so it gets its own
   * tailnet identity and is reachable cross-node by `<hostname>.<tailnet>.ts.net`
   * — no subnet routes, no approvals, works on every kernel incl. WSL2.
   *
   * The sidecar also joins the bundle's stack-private `network` under the
   * service's `alias`, so co-located siblings still resolve it by serviceName,
   * and the shared service can reach private siblings (mongo/engines). Host ports
   * are published on the SIDECAR (the netns owner) only when `publishHost` is set
   * (a core's `web` :80 front door). Idempotent: replaces an existing sidecar of
   * the same name. Returns the sidecar container id.
   */
  private async ensureSidecar(opts: {
    name: string;
    hostname: string;
    authKey: string;
    network?: string;
    alias?: string;
    ports?: RunContainerSpec['ports'];
    publishHost?: boolean;
  }): Promise<string> {
    await this.pullImage('tailscale/tailscale:latest');
    await this.removeIfExists(opts.name);

    const { exposedPorts, portBindings } = buildPorts(opts.ports, opts.publishHost ?? false);
    const endpointsConfig =
      opts.network && opts.alias ? { [opts.network]: { Aliases: [opts.alias] } } : undefined;

    const container = await this.docker.createContainer({
      Image: 'tailscale/tailscale:latest',
      name: opts.name,
      Hostname: opts.hostname,
      Env: [
        `TS_AUTHKEY=${opts.authKey}`,
        `TS_HOSTNAME=${opts.hostname}`,
        // Kernel mode (tailscale0 tun + MASQUERADE) is what makes a shared-netns
        // service actually reachable on the tailnet; userspace mode cannot.
        'TS_USERSPACE=false',
        'TS_STATE_DIR=/var/lib/tailscale',
        // Accept MagicDNS so the shared service can resolve OTHER fleet services'
        // names for cross-node egress (e.g. an app's backend dialing its core).
        'TS_ACCEPT_DNS=true',
      ],
      ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
      HostConfig: {
        NetworkMode: opts.network,
        PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
        CapAdd: ['NET_ADMIN', 'NET_RAW'],
        Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
        Sysctls: { 'net.ipv4.ip_forward': '1' },
        RestartPolicy: { Name: 'unless-stopped' },
      },
      NetworkingConfig: endpointsConfig ? { EndpointsConfig: endpointsConfig } : undefined,
    });
    await container.start();
    return container.id.slice(0, 12);
  }

  /**
   * Deploy a whole multi-container app bundle as a unit.
   *
   * Ensures the shared per-app private network, then starts each service in
   * `dependsOn` order. A service flagged for tailnet exposure (`svc.tailnet`)
   * gets its own Tailscale sidecar (its tailnet identity + MagicDNS name) and
   * runs in that sidecar's netns; a private service (mongo/engine) runs directly
   * on the stack network under its serviceName alias. Env placeholders are
   * resolved by the control plane before dispatch — the agent runs env verbatim.
   * Partial-failure policy: best effort — every service is attempted, failures
   * are reported per-service, already-started services are left running.
   */
  async deployBundle(spec: BundleSpec): Promise<BundleServiceResult[]> {
    if (spec.networkName) await this.ensureNetwork(spec.networkName);
    const ordered = orderServicesByDependsOn(spec.services);
    const results: BundleServiceResult[] = [];
    for (const svc of ordered) {
      const containerName = svc.name ?? `${spec.appKey}-${svc.serviceName}`;
      try {
        if (svc.tailnet) {
          const sidecarName = `${containerName}-ts`;
          const sidecarId = await this.ensureSidecar({
            name: sidecarName,
            hostname: svc.tailnet.hostname,
            authKey: svc.tailnet.authKey,
            network: spec.networkName,
            alias: svc.serviceName,
            ports: svc.ports,
            publishHost: svc.publishHost ?? spec.isCore === true,
          });
          const id = await this.runContainerInNetns({ ...svc, name: containerName }, sidecarId, svc.auth);
          results.push({ serviceName: svc.serviceName, containerName, ok: true, containerId: id });
        } else {
          const id = await this.runContainer({ ...svc, name: containerName, network: spec.networkName }, svc.auth, {
            networkAlias: svc.serviceName,
            publishHost: svc.publishHost ?? false,
          });
          results.push({ serviceName: svc.serviceName, containerName, ok: true, containerId: id });
        }
      } catch (err) {
        results.push({ serviceName: svc.serviceName, containerName, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /**
   * Tear down a bundle as a unit: stop+remove each named container AND its
   * Tailscale sidecar (`<container>-ts`, if any) so an exposed service's ephemeral
   * tailnet device disappears with it. Tolerates already-gone containers
   * (idempotent), then removes the shared stack-private network (best-effort;
   * left as-is if missing or still in use).
   */
  async removeBundle(spec: BundleRemoveSpec): Promise<BundleServiceResult[]> {
    const results: BundleServiceResult[] = [];
    for (const name of spec.containerNames) {
      try {
        await this.removeIfExists(name);
        await this.removeIfExists(`${name}-ts`); // its sidecar, if exposed
        results.push({ serviceName: '', containerName: name, ok: true });
      } catch (err) {
        results.push({ serviceName: '', containerName: name, ok: false, error: (err as Error).message });
      }
    }
    // A co-located app ran on its core's SHARED network — never remove that; it
    // belongs to the core (docker would refuse anyway while the core is attached,
    // but skipping avoids a misleading error and a race if the core is momentarily
    // down). Only remove a bundle's OWN per-app network.
    if (spec.networkName && !spec.sharedNetwork) {
      try {
        await this.docker.getNetwork(spec.networkName).remove();
      } catch {
        /* network missing or still in use — leave it */
      }
    }
    return results;
  }

  /** Create the per-app bridge network if it does not already exist. */
  private async ensureNetwork(name: string): Promise<void> {
    if (!name) return;
    const nets = await this.docker.listNetworks();
    if (nets.some((n) => n.Name === name)) return;
    await this.docker.createNetwork({ Name: name, Driver: 'bridge' });
  }

  async control(target: string, action: 'stop' | 'start' | 'restart' | 'remove'): Promise<void> {
    const info = await this.findByName(target);
    const id = info?.Id ?? target; // allow id directly
    const container = this.docker.getContainer(id);
    if (action === 'stop') await container.stop({ t: 10 });
    else if (action === 'start') await container.start();
    else if (action === 'restart') await container.restart({ t: 10 });
    else await container.remove({ force: true });
  }

  /** Force-remove a container by name if present (idempotent helper). */
  private async removeIfExists(name?: string): Promise<void> {
    if (!name) return;
    const existing = await this.findByName(name);
    if (!existing) return;
    try {
      await this.docker.getContainer(existing.Id).remove({ force: true });
    } catch {
      /* ignore */
    }
  }

  private async findByName(name: string): Promise<Docker.ContainerInfo | null> {
    const list = await this.docker.listContainers({ all: true });
    return list.find((c) => (c.Names ?? []).some((n) => n.replace(/^\//, '') === name)) ?? null;
  }
}

/** Build dockerode ExposedPorts + (optional) host PortBindings from a run spec. */
function buildPorts(
  ports: RunContainerSpec['ports'],
  publishHost: boolean,
): { exposedPorts: Record<string, Record<string, never>>; portBindings: Record<string, Array<{ HostPort: string }>> } {
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const p of ports ?? []) {
    const key = `${p.container}/${p.protocol ?? 'tcp'}`;
    exposedPorts[key] = {};
    if (publishHost) portBindings[key] = [{ HostPort: String(p.host) }];
  }
  return { exposedPorts, portBindings };
}

/**
 * Order bundle services so each follows the siblings it `dependsOn`. Only the
 * services present in this batch are ordered — a `dependsOn` pointing at a
 * service placed on another node (or already running) is simply ignored. Cycles
 * are tolerated: a node already being expanded is appended once it unwinds.
 */
function orderServicesByDependsOn(services: BundleServiceSpec[]): BundleServiceSpec[] {
  const byName = new Map(services.map((s) => [s.serviceName, s]));
  const ordered: BundleServiceSpec[] = [];
  const visited = new Set<string>();
  const inProgress = new Set<string>();

  const visit = (svc: BundleServiceSpec): void => {
    if (visited.has(svc.serviceName)) return;
    if (inProgress.has(svc.serviceName)) return;
    inProgress.add(svc.serviceName);
    for (const dep of svc.dependsOn ?? []) {
      const depSvc = byName.get(dep);
      if (depSvc) visit(depSvc);
    }
    inProgress.delete(svc.serviceName);
    visited.add(svc.serviceName);
    ordered.push(svc);
  };

  for (const svc of services) visit(svc);
  return ordered;
}

function normalizeArch(arch: string): string {
  const a = arch.toLowerCase();
  if (a === 'x86_64' || a === 'x64') return 'amd64';
  if (a === 'aarch64' || a === 'arm64') return 'arm64';
  return a;
}

function computeCpuPercent(stats: any): number {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpus = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1) || 1;
    if (systemDelta > 0 && cpuDelta >= 0) {
      return Math.round((cpuDelta / systemDelta) * cpus * 100 * 10) / 10;
    }
  } catch {
    /* fall through */
  }
  return 0;
}

function computeMem(stats: any): { usedMB: number; percent: number } {
  try {
    const cache = stats.memory_stats.stats?.inactive_file ?? stats.memory_stats.stats?.cache ?? 0;
    const used = Math.max(0, (stats.memory_stats.usage ?? 0) - cache);
    const limit = stats.memory_stats.limit ?? 0;
    return {
      usedMB: Math.round((used / (1024 * 1024)) * 10) / 10,
      percent: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0,
    };
  } catch {
    return { usedMB: 0, percent: 0 };
  }
}
