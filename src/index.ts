import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentConfig } from './config.js';
import { DockerClient } from './docker.js';
import { poll } from './transport.js';
import {
  FLEET_PROTOCOL_VERSION,
  type Command,
  type CommandResult,
  type NodeInfo,
  type PollRequest,
} from './protocol.js';

/**
 * Single source of truth for the agent version: read it from package.json (the
 * same value CI uses to tag the image). This guarantees the version reported to
 * the control plane — and shown per-node in the Fleet UI — always matches the
 * running image, so a version bump is a meaningful, visible signal of "this
 * host is on a newer agent". package.json sits one level up from dist/ (and
 * from src/ under tsx) and is copied into the runtime image by the Dockerfile.
 */
function resolveAgentVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const v = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
    return typeof v === 'string' && v.trim() ? v.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const AGENT_VERSION = resolveAgentVersion();

/** Stable node id: persisted to a file so restarts keep identity. */
function resolveNodeId(file: string): string {
  try {
    if (existsSync(file)) {
      const id = readFileSync(file, 'utf-8').trim();
      if (id) return id;
    }
    const id = randomUUID();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, id, 'utf-8');
    return id;
  } catch {
    // Read-only fs (no persisted volume): fall back to a host-stable id.
    return `eph-${process.env.HOSTNAME ?? randomUUID()}`;
  }
}

/** Where the per-node token lives: explicit flag, else a sibling of the id file. */
function resolveTokenFile(config: { nodeTokenFile: string; nodeIdFile: string }): string {
  return config.nodeTokenFile || path.join(path.dirname(config.nodeIdFile), 'node-token');
}

/** Read the persisted per-node token, or '' if none has been issued yet. */
function readNodeToken(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, 'utf-8').trim() : '';
  } catch {
    return '';
  }
}

/** Persist a freshly issued per-node token next to the node id. Best-effort. */
function persistNodeToken(file: string, token: string): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, token, { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch (err) {
    console.warn(`[fleet-agent] could not persist node token: ${(err as Error).message}`);
    return false;
  }
}

async function main(): Promise<void> {
  const config = getAgentConfig();
  if (!config.coreUrl) throw new Error('--core-url (or FLEET_CORE_URL) is required');

  const tokenFile = resolveTokenFile(config);
  let nodeToken = readNodeToken(tokenFile);
  // The join key only bootstraps the first enrollment; once a per-node token is
  // persisted it is optional, so the agent can run with token-only credentials.
  if (!config.joinKey && !nodeToken) {
    throw new Error('--join-key (or FLEET_JOIN_KEY) is required for first enrollment');
  }

  const docker = new DockerClient(config.dockerSocketPath);
  const nodeId = resolveNodeId(config.nodeIdFile);
  const host = await docker.hostInfo();

  const node: NodeInfo = {
    nodeId,
    name: config.name,
    os: host.os,
    arch: host.arch,
    kernel: host.kernel,
    dockerVersion: host.dockerVersion,
    agentVersion: AGENT_VERSION,
    tailnetName: config.tailnetName || undefined,
    tailscaleIp: config.tailscaleIp || undefined,
  };

  const dockerOk = await docker.ping();
  console.log(`[fleet-agent] ${config.name} (${nodeId}) arch=${host.arch} docker=${dockerOk ? 'ok' : 'UNREACHABLE'} → ${config.coreUrl}`);

  let pollIntervalMs = config.pollIntervalMs;
  let pendingResults: CommandResult[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const containers = await docker.sampleContainers();
      const req: PollRequest = {
        protocolVersion: FLEET_PROTOCOL_VERSION,
        node,
        containers,
        results: pendingResults,
      };
      const res = await poll(config.coreUrl, { joinKey: config.joinKey, nodeToken }, req);
      pendingResults = []; // delivered

      // The control plane issues this node its own token exactly once. Persist
      // it and present it from now on, so we stop relying on the shared key.
      if (res.issuedToken && res.issuedToken !== nodeToken) {
        if (persistNodeToken(tokenFile, res.issuedToken)) {
          nodeToken = res.issuedToken;
          console.log('[fleet-agent] received and stored per-node token');
        }
      }

      if (typeof res.pollIntervalMs === 'number' && res.pollIntervalMs >= 1000) {
        pollIntervalMs = res.pollIntervalMs;
      }

      if (res.commands?.length) {
        if (!res.approved) {
          console.log('[fleet-agent] received commands but node not approved — ignoring');
        } else {
          for (const cmd of res.commands) {
            pendingResults.push(await execute(docker, cmd));
          }
        }
      }
    } catch (err) {
      console.warn(`[fleet-agent] poll failed: ${(err as Error).message}`);
    }
    await sleep(pollIntervalMs);
  }
}

async function execute(docker: DockerClient, cmd: Command): Promise<CommandResult> {
  const finishedAt = () => new Date().toISOString();
  try {
    switch (cmd.kind) {
      case 'run': {
        if (!cmd.spec) throw new Error('run command missing spec');
        const id = await docker.runContainer(cmd.spec, cmd.auth);
        return { id: cmd.id, ok: true, detail: `started ${cmd.spec.name ?? cmd.spec.image} (${id})`, finishedAt: finishedAt() };
      }
      case 'pull': {
        if (!cmd.target) throw new Error('pull command missing image');
        await docker.pullImage(cmd.target, cmd.auth);
        return { id: cmd.id, ok: true, detail: `pulled ${cmd.target}`, finishedAt: finishedAt() };
      }
      case 'updateAgent': {
        if (!cmd.target) throw new Error('updateAgent command missing image');
        const helperId = await docker.selfUpdate(cmd.target, cmd.auth);
        return {
          id: cmd.id,
          ok: true,
          detail: `pulled ${cmd.target}; recreating agent via helper ${helperId}`,
          finishedAt: finishedAt(),
        };
      }
      case 'deployApp': {
        if (!cmd.bundle) throw new Error('deployApp command missing bundle');
        const services = await docker.deployBundle(cmd.bundle);
        const failed = services.filter((s) => !s.ok);
        return {
          id: cmd.id,
          ok: failed.length === 0,
          detail: `deployed ${cmd.bundle.appKey}: ${services.length - failed.length}/${services.length} services up`,
          error: failed.length ? failed.map((s) => `${s.serviceName}: ${s.error}`).join('; ') : undefined,
          services,
          finishedAt: finishedAt(),
        };
      }
      case 'removeApp': {
        if (!cmd.removeBundle) throw new Error('removeApp command missing removeBundle');
        const services = await docker.removeBundle(cmd.removeBundle);
        const failed = services.filter((s) => !s.ok);
        return {
          id: cmd.id,
          ok: failed.length === 0,
          detail: `removed ${cmd.removeBundle.appKey}: ${services.length - failed.length}/${services.length} containers`,
          error: failed.length ? failed.map((s) => `${s.containerName}: ${s.error}`).join('; ') : undefined,
          services,
          finishedAt: finishedAt(),
        };
      }
      case 'stop':
      case 'start':
      case 'restart':
      case 'remove': {
        if (!cmd.target) throw new Error(`${cmd.kind} command missing target`);
        await docker.control(cmd.target, cmd.kind);
        return { id: cmd.id, ok: true, detail: `${cmd.kind} ${cmd.target}`, finishedAt: finishedAt() };
      }
      default:
        return { id: cmd.id, ok: false, error: `unknown command kind: ${(cmd as Command).kind}`, finishedAt: finishedAt() };
    }
  } catch (err) {
    return { id: cmd.id, ok: false, error: (err as Error).message, finishedAt: finishedAt() };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('[fleet-agent] fatal:', err);
  process.exit(1);
});
