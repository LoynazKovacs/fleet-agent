# Fleet Agent

A tiny daemon that makes a Docker host manageable from the Fleet control plane.
It mounts the local Docker socket, dials **out** to the control plane, reports
the host + its containers, and runs deploy / control commands once the node is
approved. It contains no platform secrets, so the image is public.

## Install (one-liner)

```sh
# The image lives in Artifact Registry; log in once with a read-only AR key first:
#   cat ar-readonly-key.json | docker login -u _json_key --password-stdin https://europe-central2-docker.pkg.dev
docker run -d --name fleet-agent --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v fleet-agent-id:/data \
  europe-central2-docker.pkg.dev/theitemapp/theitemapp/fleet-agent:latest \
  --core-url https://<core-host>/fleet-api \
  --join-key <FLEET_JOIN_KEY> \
  --name <label-for-this-machine>
```

- `--core-url` — base URL of the control plane (core's host + `/fleet-api`). Over Tailscale this is your core machine's tailnet name. The control plane is **tailnet-only** — dial it over Tailscale, not a public address.
- `--join-key` — the shared **bootstrap** secret; must match the control plane's `FLEET_JOIN_KEY`. Only needed for the first enrollment (see below).
- `--name` — optional; defaults to the hostname.
- The `fleet-agent-id` volume persists the node's stable id **and its issued token** across restarts.

### Per-node token
On its first poll the agent enrolls with the join key and the control plane
hands back this node's own long-lived token. The agent writes it to
`node-token` (next to `node-id`, in the persisted volume) and presents it on
every subsequent poll, so it stops depending on the shared key. Because the
token lives in the volume, keep that volume — and once a token is present the
agent can run without `--join-key`. Override the token's location with
`--node-token-file` / `FLEET_NODE_TOKEN_FILE`. Rejecting the node in the Fleet
UI revokes the token immediately.

> **Re-enrolling a rejected node:** rejection clears the node's stored token, so
> re-approving it does not restore the old token — the node must re-enroll. Keep
> `--join-key` configured (even alongside a persisted token) so a reject →
> re-approve cycle self-heals on the next poll. A token-only agent with no join
> key would otherwise need an operator to re-supply the join key.

All flags can also be given as env vars: `FLEET_CORE_URL`, `FLEET_JOIN_KEY`,
`FLEET_NODE_NAME`, `FLEET_POLL_INTERVAL_MS`, `FLEET_TAILNET_NAME`,
`FLEET_TAILSCALE_IP`, `FLEET_NODE_ID_FILE`, `FLEET_NODE_TOKEN_FILE`.

## What it can do (stage 1)
- Report host facts (os/arch/kernel, docker + agent version) and live container inventory.
- `run` a container (pull image → create → start), `stop` / `start` / `restart` / `remove`, `pull`.

Multi-arch image: `linux/amd64` and `linux/arm64` (Raspberry Pi).
