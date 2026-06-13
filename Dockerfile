# syntax=docker/dockerfile:1
#
# Fleet Agent — the distributable daemon that runs on every managed host
# (cloud VM, home PC, Raspberry Pi). It mounts the local Docker socket, dials
# OUT to the control plane (poll), and executes deploy/control commands.
#
# Contains NO platform secrets or business logic — safe to publish publicly.
# Built multi-arch (amd64 + arm64) in CI via buildx; the Dockerfile itself is
# arch-agnostic (node:20-bookworm-slim ships both).

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Persist the stable node id here — mount a small volume to keep identity
# across restarts:  -v fleet-agent-id:/data
VOLUME ["/data"]

# ENTRYPOINT (not CMD) so `docker run <image> --core-url ... --join-key ...`
# appends the flags to node instead of replacing the command.
ENTRYPOINT ["node", "dist/index.js"]
