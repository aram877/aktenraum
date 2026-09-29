# Build stage — produces apps/web/dist via pnpm.
FROM node:22-alpine AS builder

# Install pnpm via corepack (matches the pinned version in the root package.json).
RUN corepack enable

WORKDIR /repo

# Copy workspace manifests first for layer cache.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .nvmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/web-nuxt/package.json apps/web-nuxt/package.json

ARG WEB_APP=angular

RUN case "$WEB_APP" in \
      angular) pnpm install --frozen-lockfile=false --filter @aktenraum/web ;; \
      nuxt) pnpm install --frozen-lockfile=false --ignore-scripts --filter @aktenraum/web-nuxt ;; \
      *) echo "WEB_APP must be angular or nuxt, got '$WEB_APP'" >&2; exit 1 ;; \
    esac

# Source.
COPY apps/web/ apps/web/
COPY apps/web-nuxt/ apps/web-nuxt/

RUN case "$WEB_APP" in \
      angular) pnpm --filter @aktenraum/web build && cp -r apps/web/dist /out ;; \
      nuxt) pnpm --filter @aktenraum/web-nuxt build && cp -r apps/web-nuxt/.output/public /out ;; \
    esac

# Runtime stage — nginx alpine serving the built SPA + reverse-proxying /api.
FROM nginx:alpine

COPY docker/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /out /usr/share/nginx/html

EXPOSE 80
