# Debian, not Alpine: transformers.js pulls onnxruntime-node, whose prebuilt
# native binding is glibc-linked (`ld-linux-aarch64.so.1`). On a musl base it
# builds fine and then dies at require() time with ERR_DLOPEN_FAILED.
FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS builder

RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/aktenraum-core/package.json packages/aktenraum-core/package.json
COPY services/aktenraum-api/package.json services/aktenraum-api/package.json

RUN pnpm install --frozen-lockfile --filter @aktenraum/core... --filter @aktenraum/api...

COPY packages/aktenraum-core/ packages/aktenraum-core/
COPY services/aktenraum-api/ services/aktenraum-api/

RUN pnpm --filter @aktenraum/core build \
    && pnpm --filter @aktenraum/api build \
    && pnpm prune --prod

FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS runtime

RUN groupadd --system appuser && useradd --system --gid appuser --create-home appuser

WORKDIR /repo

COPY --from=builder --chown=appuser:appuser /repo/node_modules /repo/node_modules
COPY --from=builder --chown=appuser:appuser /repo/package.json /repo/package.json
COPY --from=builder --chown=appuser:appuser /repo/packages/aktenraum-core/package.json /repo/packages/aktenraum-core/package.json
COPY --from=builder --chown=appuser:appuser /repo/packages/aktenraum-core/dist /repo/packages/aktenraum-core/dist
COPY --from=builder --chown=appuser:appuser /repo/packages/aktenraum-core/node_modules /repo/packages/aktenraum-core/node_modules
COPY --from=builder --chown=appuser:appuser /repo/services/aktenraum-api/package.json /repo/services/aktenraum-api/package.json
COPY --from=builder --chown=appuser:appuser /repo/services/aktenraum-api/dist /repo/services/aktenraum-api/dist
# tsc emits only JS; the schema bootstrap reads this SQL at runtime.
COPY --from=builder --chown=appuser:appuser /repo/services/aktenraum-api/src/db/schema.sql /repo/services/aktenraum-api/dist/db/schema.sql
COPY --from=builder --chown=appuser:appuser /repo/services/aktenraum-api/node_modules /repo/services/aktenraum-api/node_modules

RUN mkdir -p /home/appuser/.cache/huggingface \
    && chown -R appuser:appuser /home/appuser/.cache

USER appuser

WORKDIR /repo/services/aktenraum-api

EXPOSE 8002

CMD ["node", "dist/main.js"]
