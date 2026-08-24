# Debian, not Alpine: the worker imports @aktenraum/core, which pulls
# onnxruntime-node transitively. Its prebuilt native binding is glibc-linked
# (`ld-linux-aarch64.so.1`) and dies at require() time on a musl base.
FROM node:22-slim AS builder

RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/aktenraum-core/package.json packages/aktenraum-core/package.json
COPY services/auto-tagger/package.json services/auto-tagger/package.json

RUN pnpm install --frozen-lockfile=false --filter @aktenraum/core... --filter @aktenraum/worker...

COPY packages/aktenraum-core/ packages/aktenraum-core/
COPY services/auto-tagger/ services/auto-tagger/

RUN pnpm --filter @aktenraum/core build \
    && pnpm --filter @aktenraum/worker build \
    && pnpm prune --prod

FROM node:22-slim AS runtime

RUN groupadd --system appuser && useradd --system --gid appuser --create-home appuser

WORKDIR /repo

COPY --from=builder --chown=appuser:appuser /repo/node_modules /repo/node_modules
COPY --from=builder --chown=appuser:appuser /repo/package.json /repo/package.json
COPY --from=builder --chown=appuser:appuser /repo/packages/aktenraum-core/package.json /repo/packages/aktenraum-core/package.json
COPY --from=builder --chown=appuser:appuser /repo/packages/aktenraum-core/dist /repo/packages/aktenraum-core/dist
COPY --from=builder --chown=appuser:appuser /repo/packages/aktenraum-core/node_modules /repo/packages/aktenraum-core/node_modules
COPY --from=builder --chown=appuser:appuser /repo/services/auto-tagger/package.json /repo/services/auto-tagger/package.json
COPY --from=builder --chown=appuser:appuser /repo/services/auto-tagger/dist /repo/services/auto-tagger/dist
COPY --from=builder --chown=appuser:appuser /repo/services/auto-tagger/node_modules /repo/services/auto-tagger/node_modules

USER appuser

WORKDIR /repo/services/auto-tagger

EXPOSE 8001

CMD ["node", "dist/main.js"]
