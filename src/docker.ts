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
   * Create + start a single container from a run spec. Returns its id.
   *
   * `opts.networkAlias` adds a DNS alias for the container on `spec.network` so
   * a bundle's siblings can reach it by its service name even though its actual
   * container name is the deterministic `<app>-<service>-<suffix>`.
   *
   * `opts.staticIp` pins the container to a known IPv4 on `spec.network` (so its
   * reachable address is determinable at create time — used by the bundle path
   * to resolve `${service.publicUrl}`). `opts.dns` overrides the container's DNS
   * servers (the bundle path points these at the tailnet MagicDNS resolver so a
   * deployed app can resolve core's serve name). Both are additive and only set
   * by the bundle path — the plain single-container `run` path leaves them off.
   */
  async runContainer(
    spec: RunContainerSpec,
    auth?: RegistryAuth,
    opts?: { networkAlias?: string; staticIp?: string; dns?: string[] },
  ): Promise<string> {
    if (spec.pull !== false) {
      await this.pullImage(spec.image, auth);
    }

    // Replace an existing container with the same name so deploy is idempotent.
    if (spec.name) {
      const existing = await this.findByName(spec.name);
      if (existing) {
        const c = this.docker.getContainer(existing.Id);
        try {
          await c.remove({ force: true });
        } catch {
          /* ignore */
        }
      }
    }

    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const exposedPorts: Record<string, Record<string, never>> = {};
    for (const p of spec.ports ?? []) {
      const key = `${p.container}/${p.protocol ?? 'tcp'}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(p.host) }];
    }

    const binds = (spec.volumes ?? []).map((v) => `${v.host}:${v.container}${v.readOnly ? ':ro' : ''}`);

    const endpoint: { Aliases?: string[]; IPAMConfig?: { IPv4Address: string } } = {};
    if (opts?.networkAlias) endpoint.Aliases = [opts.networkAlias];
    if (opts?.staticIp) endpoint.IPAMConfig = { IPv4Address: opts.staticIp };
    const endpointsConfig =
      spec.network && Object.keys(endpoint).length ? { [spec.network]: endpoint } : undefined;

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
        Dns: opts?.dns && opts.dns.length ? opts.dns : undefined,
        RestartPolicy: spec.restart && spec.restart !== 'no' ? { Name: spec.restart } : undefined,
      },
      NetworkingConfig: endpointsConfig ? { EndpointsConfig: endpointsConfig } : undefined,
    });
    await container.start();
    return container.id.slice(0, 12);
  }

  /**
   * Deploy a whole multi-container app bundle as a unit.
   *
   * Ensures the shared per-app network exists, then starts each service in
   * `dependsOn` order: pull (with the service's own auth), replace any container
   * of the same name (idempotent re-deploy), attach to the app network with a
   * DNS alias of the service name so siblings resolve each other by name, and
   * publish only the service's ingress ports. Partial-failure policy: best
   * effort — every service is attempted, a failure is reported per-service, and
   * already-started services are LEFT RUNNING (no rollback).
   */
  async deployBundle(spec: BundleSpec): Promise<BundleServiceResult[]> {
    await this.ensureNetwork(spec.networkName);
    // The fleet net's IPAM base (e.g. "10.42.0" from 10.42.0.0/24) — needed to
    // assign deterministic static IPs to the bundle's services. Null if the
    // network has no inspectable subnet: we then skip static IPs + the endpoints
    // map and leave any `${service.publicUrl}` literal (best effort, never crash).
    const subnetBase = await this.networkSubnetBase(spec.networkName);
    const ordered = orderServicesByDependsOn(spec.services);
    const results: BundleServiceResult[] = [];

    // Assign a deterministic static fleet-net IP to EVERY service up front:
    //  (a) each service becomes reachable from core at a known address (core's
    //      Caddy proxies the frontend remote + api over the tailnet), and
    //  (b) we can hand the registrant a `serviceName -> IP` map so its SDK can
    //      rewrite manifest route upstreams (docker name → fleet IP).
    // Index-based + dependsOn-ordered ⇒ stable across re-deploys: first service
    // gets <base>.10, second <base>.11, … A null subnet (uninspectable network)
    // ⇒ no static IPs and no endpoints map — co-located fallback where siblings
    // still resolve each other by docker alias.
    const ipByService = new Map<string, string>();
    if (subnetBase) {
      ordered.forEach((svc, i) => ipByService.set(svc.serviceName, `${subnetBase}.${10 + i}`));
    }
    const endpointsJson = ipByService.size
      ? JSON.stringify(Object.fromEntries(ipByService))
      : undefined;

    for (const svc of ordered) {
      const containerName = svc.name ?? `${spec.appKey}-${svc.serviceName}`;
      try {
        const staticIp = ipByService.get(svc.serviceName);
        let env = svc.env;
        if (env || endpointsJson) {
          const next: Record<string, string> = { ...(env ?? {}) };
          // Resolve this service's OWN `${service.publicUrl}` to its assigned IP
          // (first exposed port is its ingress; host-only if it has no port).
          if (staticIp) {
            const port = svc.ports?.[0]?.container;
            const publicUrl = port ? `http://${staticIp}:${port}` : `http://${staticIp}`;
            for (const k of Object.keys(next)) {
              next[k] = next[k].replaceAll('${service.publicUrl}', publicUrl);
            }
          }
          // Hand every service the bundle's serviceName→fleet-IP map; the
          // registrant's SDK uses it to rewrite manifest route upstreams.
          // Harmless on non-registrant services.
          if (endpointsJson) next.FLEET_SERVICE_ENDPOINTS = endpointsJson;
          env = next;
        }
        const id = await this.runContainer(
          { ...svc, name: containerName, network: spec.networkName, env },
          svc.auth,
          // MagicDNS so the deployed app can resolve core's tailnet serve name;
          // static IP (when assigned) pins the address baked into publicUrl.
          { networkAlias: svc.serviceName, staticIp, dns: ['100.100.100.100'] },
        );
        results.push({ serviceName: svc.serviceName, containerName, ok: true, containerId: id });
      } catch (err) {
        results.push({ serviceName: svc.serviceName, containerName, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /**
   * The first three octets of a network's IPAM subnet base (e.g. "10.42.0" from
   * `10.42.0.0/24`), used to compute deterministic static IPs for bundle
   * services. Returns null if the network is missing, has no IPAM config, or its
   * subnet isn't a parseable IPv4 — callers then fall back to no static IP.
   */
  private async networkSubnetBase(name: string): Promise<string | null> {
    try {
      const net = (await this.docker.getNetwork(name).inspect()) as any;
      const subnet: string | undefined = net?.IPAM?.Config?.[0]?.Subnet;
      if (!subnet) return null;
      const octets = subnet.split('/')[0]?.split('.') ?? [];
      if (octets.length !== 4) return null;
      return octets.slice(0, 3).join('.');
    } catch {
      return null;
    }
  }

  /**
   * Tear down a bundle as a unit: stop+remove each named container (tolerating
   * any that are already gone, so remove is idempotent), then remove the shared
   * network. The network removal is best-effort — left as-is if it is missing or
   * still has other members attached.
   */
  async removeBundle(spec: BundleRemoveSpec): Promise<BundleServiceResult[]> {
    const results: BundleServiceResult[] = [];
    for (const name of spec.containerNames) {
      try {
        const existing = await this.findByName(name);
        if (existing) {
          await this.docker.getContainer(existing.Id).remove({ force: true });
        }
        // Absent container is a no-op success — removeApp is idempotent.
        results.push({ serviceName: '', containerName: name, ok: true });
      } catch (err) {
        results.push({ serviceName: '', containerName: name, ok: false, error: (err as Error).message });
      }
    }
    if (spec.networkName) {
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

  // ── Stage 3: fleet network + Tailscale subnet-router (gated by FLEET_NET_ENABLED) ──

  /**
   * Ensure the node's fleet network exists on its control-plane-assigned subnet.
   * Unlike the per-app network this is a single, stable, node-wide bridge whose
   * subnet is unique across the fleet so the Tailscale subnet-router can
   * advertise it without colliding with another node's routes. Idempotent; if a
   * network of the same name already exists we leave it (a subnet change would
   * need a manual recreate since Docker can't resize a live network).
   */
  async ensureFleetNetwork(name: string, subnet: string): Promise<void> {
    if (!name || !subnet) return;
    const nets = await this.docker.listNetworks();
    if (nets.some((n) => n.Name === name)) return;
    await this.docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] },
    });
  }

  /**
   * Ensure the node's Tailscale subnet-router container is running. It joins the
   * tailnet with the node's (single-use) auth key, ADVERTISES the fleet subnet so
   * the whole fleet network is reachable from other tailnet nodes, and ACCEPTS
   * the routes other nodes advertise so containers here can reach them. Kernel
   * routing needs NET_ADMIN + /dev/net/tun + ip_forward. Idempotent: replaces an
   * existing router of the same name (e.g. on subnet change / restart).
   *
   * NOTE (to validate in the supervised bring-up): inbound (other node → this
   * fleet-net) works with the router attached to fleet-net + advertise-routes.
   * Outbound (a fleet-net container → another node's subnet) additionally needs
   * fleet-net containers to route the tailnet pool via this router — to be
   * confirmed live; may require an explicit route or making the router the
   * gateway for 10.42.0.0/16.
   */
  async ensureSubnetRouter(opts: {
    containerName: string;
    networkName: string;
    hostname: string;
    authKey: string;
    subnet: string;
    stateVolume: string;
  }): Promise<string> {
    await this.pullImage('tailscale/tailscale:latest');
    const existing = await this.findByName(opts.containerName);
    if (existing) {
      try {
        await this.docker.getContainer(existing.Id).remove({ force: true });
      } catch {
        /* ignore */
      }
    }
    const container = await this.docker.createContainer({
      Image: 'tailscale/tailscale:latest',
      name: opts.containerName,
      Hostname: opts.hostname,
      Env: [
        `TS_AUTHKEY=${opts.authKey}`,
        `TS_HOSTNAME=${opts.hostname}`,
        `TS_ROUTES=${opts.subnet}`,
        // CRITICAL: the tailscale image DEFAULTS to userspace networking, which
        // CANNOT subnet-route — advertise-routes is silently a no-op and pulls
        // through the router time out. Forcing kernel mode (tailscale0 tun +
        // MASQUERADE) is the one flag that makes routing actually work. Proven
        // live 2026-06-12 (master + laptop); see docs/stage3-networking.
        'TS_USERSPACE=false',
        'TS_EXTRA_ARGS=--accept-routes --advertise-tags=tag:fleet',
        'TS_STATE_DIR=/var/lib/tailscale',
        'TS_ACCEPT_DNS=false',
      ],
      HostConfig: {
        // Attach to the fleet network so the router can forward into it.
        NetworkMode: opts.networkName,
        // NET_ADMIN drives the routing tables; NET_RAW is needed by kernel-mode
        // tailscaled for its netfilter/MASQUERADE rules. Both stay network-only
        // (not host-root) — the security boundary is unchanged.
        CapAdd: ['NET_ADMIN', 'NET_RAW'],
        Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
        Sysctls: { 'net.ipv4.ip_forward': '1' },
        Binds: [`${opts.stateVolume}:/var/lib/tailscale`],
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    await container.start();
    return container.id.slice(0, 12);
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

  private async findByName(name: string): Promise<Docker.ContainerInfo | null> {
    const list = await this.docker.listContainers({ all: true });
    return list.find((c) => (c.Names ?? []).some((n) => n.replace(/^\//, '') === name)) ?? null;
  }
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
