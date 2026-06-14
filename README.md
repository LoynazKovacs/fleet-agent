# Fleet Agent — standalone node

Clone this repo onto any Docker host, fill five env vars, run **one** compose
command, and that host is fully on the fleet: joined to the tailnet, advertising
its app subnet, accepting other nodes' routes, with the agent polling the
control plane to run deploys. No manual `docker run` or `ip route` ever again.

The compose bundle wires up four pieces (see comments in `docker-compose.yml`):
**tailscale** (kernel mode, joins the tailnet + advertises this node's subnet),
**agent** (shares tailscale's netns, polls core, executes deploys), **router**
(adds host routes so this host's app containers reach the tailnet), and
**fleet-net** (the docker network app bundles deploy into — its subnet is what
tailscale advertises so core can reach apps here).

## Quickstart

```sh
git clone https://github.com/LoynazKovacs/fleet-agent.git
cd fleet-agent
cp .env.example .env      # then edit .env and fill the 5 vars below

# One-time: log in to Artifact Registry with a READ-ONLY AR key so the node
# (and the self-updater) can pull the agent image. Same registry as every other
# app image — no GHCR, no GitHub token.
cat ar-readonly-key.json | docker login -u _json_key --password-stdin https://europe-central2-docker.pkg.dev

docker compose up -d
```

The agent image lives in **Artifact Registry**
(`europe-central2-docker.pkg.dev/theitemapp/theitemapp/fleet-agent`), authed with
a GCP key — the same registry and auth as every other app image. Use a
**read-only** AR key on nodes (`roles/artifactregistry.reader`), **not** the
writer/deploy SA.

The five vars in `.env`:

| Var | What it is |
|-----|------------|
| `FLEET_NODE_NAME` | Unique label + tailscale hostname for this machine. |
| `FLEET_CORE_URL` | Control plane base URL — core's stable MagicDNS serve URL (tailnet-only), e.g. `https://master.tail28a9b4.ts.net/fleet-api`. |
| `FLEET_JOIN_KEY` | Shared bootstrap enrolment secret; must match the control plane's `FLEET_JOIN_KEY`. |
| `FLEET_TS_AUTHKEY` | This node's Tailscale auth key (per-device — generate one in the Tailscale admin console). |
| `FLEET_SUBNET` | This node's app subnet, **unique per node**. See *Getting your subnet* below. |

## One-time route approval

After the first `docker compose up -d`, this node advertises its `FLEET_SUBNET`
to the tailnet. Approve it **once** in the [Tailscale admin console]
(https://login.tailscale.com/admin/machines) → this machine → **Edit route
settings** → approve the subnet. Until approved, core can't reach apps on this
node.

**Skip even that:** add an `autoApprovers` block to your tailnet ACL so any node
tagged `tag:fleet` gets its routes approved automatically:

```jsonc
"autoApprovers": {
  "routes": {
    "10.42.0.0/16": ["tag:fleet"]
  }
}
```

(Tag nodes with `tag:fleet` via the auth key's tag settings.)

## Getting your subnet

Each node needs its **own** `FLEET_SUBNET` (a unique `/24` that no other node
uses) so addresses don't collide across the fleet. The fleet **Nodes** view in
the platform assigns and tracks one per node — use the value it shows for this
machine. The default `10.42.0.0/24` is only safe for a single node.

## Updating

**Control-plane driven — from the platform, zero hands-on at the node.** Push a
new agent image from master → CI builds + pushes it to Artifact Registry → click
**Update agent** on the node row in the fleet **Nodes** view. The control plane
sends an `updateAgent` command with a short-lived registry token (the same
brokered auth it uses for app deploys), the agent pulls the new image, and a
detached helper runs `docker compose up -d agent` to recreate it from the pulled
image (`--pull never`, so no node-side registry creds are needed). The node's
reported `agentVersion` bumps when the new agent boots.

This replaces the old watchtower sidecar, which couldn't use the brokered auth
and so required a standing GAR login on every node. For self-update to work the
agent must know this repo's host path — the compose passes it as
`FLEET_COMPOSE_DIR` (`${PWD}`); set it in `.env` only if you run compose from
another directory.

Identity (node id + token) lives in the `agent-id` volume and tailscale state in
`tailscale-state`, so updates never re-enroll the node.

**Manual** (e.g. to also pull a new `tailscale` image):

```sh
docker compose pull && docker compose up -d
```

## Core node

A host that runs a theitemapp **core** uses the same tailscale pattern, but it
advertises the **core's** docker network instead of an app subnet, and routes
the whole tailnet so core can reach apps on every other node:

```sh
FLEET_SUBNET=172.18.0.0/16                       # core's docker network (TS_ROUTES)
FLEET_ROUTE_RANGES="100.64.0.0/10 10.42.0.0/16"  # reach tailnet + all node app subnets
```

Everything else (auth key, route approval) is identical.

## Agent details

See [`AGENT.md`](./AGENT.md) for the agent daemon itself — its flags, the
per-node token enrolment flow, and what it can do.
