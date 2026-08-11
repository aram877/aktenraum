# Debian, not Alpine: transformers.js pulls onnxruntime-node, whose prebuilt
# native binding is glibc-linked (`ld-linux-aarch64.so.1`). On a musl base it
# builds fine and then dies at require() time with ERR_DLOPEN_FAILED.
FROM node:22-slim AS builder

RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core-ts/package.json packages/core-ts/package.json
COPY services/api-node/package.json services/api-node/package.json

RUN pnpm install --frozen-lockfile=false --filter @aktenraum/core-ts... --filter @aktenraum/api-node...

COPY packages/core-ts/ packages/core-ts/
COPY services/api-node/ services/api-node/

RUN pnpm --filter @aktenraum/core-ts build \
    && pnpm --filter @aktenraum/api-node build \
    && pnpm prune --prod

FROM node:22-slim AS runtime

RUN groupadd --system appuser && useradd --system --gid appuser --create-home appuser

WORKDIR /repo

COPY --from=builder --chown=appuser:appuser /repo/node_modules /repo/node_modules
COPY --from=builder --chown=appuser:appuser /repo/package.json /repo/package.json
COPY --from=builder --chown=appuser:appuser /repo/packages/core-ts/package.json /repo/packages/core-ts/package.json
COPY --from=builder --chown=appuser:appuser /repo/packages/core-ts/dist /repo/packages/core-ts/dist
COPY --from=builder --chown=appuser:appuser /repo/packages/core-ts/node_modules /repo/packages/core-ts/node_modules
COPY --from=builder --chown=appuser:appuser /repo/services/api-node/package.json /repo/services/api-node/package.json
COPY --from=builder --chown=appuser:appuser /repo/services/api-node/dist /repo/services/api-node/dist
COPY --from=builder --chown=appuser:appuser /repo/services/api-node/node_modules /repo/services/api-node/node_modules

RUN mkdir -p /home/appuser/.cache/huggingface \
    && chown -R appuser:appuser /home/appuser/.cache

USER appuser

WORKDIR /repo/services/api-node

EXPOSE 8002

CMD ["node", "dist/main.js"]
