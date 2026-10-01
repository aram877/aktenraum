# Build stage — produces the static Nuxt SPA via pnpm.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder

# Install pnpm via corepack (matches the pinned version in the root package.json).
RUN corepack enable

WORKDIR /repo

# Copy workspace manifests first for layer cache.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .nvmrc ./
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts --filter @aktenraum/web

# Source.
COPY apps/web/ apps/web/

RUN pnpm --filter @aktenraum/web build

# Runtime stage — nginx alpine serving the built SPA + reverse-proxying /api.
FROM nginx:alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2

COPY docker/nginx/security-headers.conf /etc/nginx/snippets/aktenraum-security-headers.conf
COPY docker/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/web/.output/public /usr/share/nginx/html

EXPOSE 80
