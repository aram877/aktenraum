# Build stage — produces apps/web/dist via pnpm.
FROM node:22-alpine AS builder

# Install pnpm via corepack (matches the pinned version in the root package.json).
RUN corepack enable

WORKDIR /repo

# Copy workspace manifests first for layer cache.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .nvmrc ./
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile=false

# Source.
COPY apps/web/ apps/web/

RUN pnpm --filter @aktenraum/web build

# Runtime stage — nginx alpine serving the built SPA + reverse-proxying /api.
FROM nginx:alpine

COPY docker/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80
