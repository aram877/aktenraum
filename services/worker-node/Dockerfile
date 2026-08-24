# Debian, not Alpine: the worker imports @aktenraum/core-ts, which pulls
# onnxruntime-node transitively. Its prebuilt native binding is glibc-linked
# (`ld-linux-aarch64.so.1`) and dies at require() time on a musl base.
FROM node:22-slim AS builder

RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core-ts/package.json packages/core-ts/package.json
COPY services/worker-node/package.json services/worker-node/package.json

RUN pnpm install --frozen-lockfile=false --filter @aktenraum/core-ts... --filter @aktenraum/worker-node...

COPY packages/core-ts/ packages/core-ts/
COPY services/worker-node/ services/worker-node/

RUN pnpm --filter @aktenraum/core-ts build \
    && pnpm --filter @aktenraum/worker-node build \
    && pnpm prune --prod

FROM node:22-slim AS runtime

RUN groupadd --system appuser && useradd --system --gid appuser --create-home appuser

WORKDIR /repo

COPY --from=builder --chown=appuser:appuser /repo/node_modules /repo/node_modules
COPY --from=builder --chown=appuser:appuser /repo/package.json /repo/package.json
COPY --from=builder --chown=appuser:appuser /repo/packages/core-ts/package.json /repo/packages/core-ts/package.json
COPY --from=builder --chown=appuser:appuser /repo/packages/core-ts/dist /repo/packages/core-ts/dist
COPY --from=builder --chown=appuser:appuser /repo/packages/core-ts/node_modules /repo/packages/core-ts/node_modules
COPY --from=builder --chown=appuser:appuser /repo/services/worker-node/package.json /repo/services/worker-node/package.json
COPY --from=builder --chown=appuser:appuser /repo/services/worker-node/dist /repo/services/worker-node/dist
COPY --from=builder --chown=appuser:appuser /repo/services/worker-node/node_modules /repo/services/worker-node/node_modules

USER appuser

WORKDIR /repo/services/worker-node

EXPOSE 8001

CMD ["node", "dist/main.js"]
