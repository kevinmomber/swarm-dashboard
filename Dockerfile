# --- Stage 1: build the React client ---
FROM node:22-alpine AS client
# npm registry used for the build. Override with --build-arg NPM_REGISTRY=<url>
# (e.g. a mirror/proxy feed) when the public registry is not reachable.
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app/client
COPY client/package.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm install
COPY client/ ./
RUN npm run build

# --- Stage 2: install server deps (with CVE-fixed versions + overrides) ---
FROM node:22-alpine AS server-deps
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app/server
COPY server/package.json ./
# package.json bumps nodemailer to ^10 and forces qs>=6.16, uuid>=11.1,
# proxy-addr>=2.0.8, @grpc/grpc-js>=1.14.5 and ip-address>=10.7.2 via overrides.
RUN npm config set registry "$NPM_REGISTRY" && npm install --omit=dev --no-audit --no-fund

# --- Stage 3: runtime (hardened) ---
FROM node:22-alpine
WORKDIR /app

# docker CLI is needed for `docker stack deploy` and `docker build` (the Builder
# tab); buildx enables BuildKit builds with layer cache; git for the
# Git→Compose feature. Also patch OS packages (openssl etc.) and drop the global
# npm CLI + corepack — they are build tools never executed at runtime (CMD
# launches `node`; the app only ever spawns the `git`/`docker` CLIs). This
# removes the CVE findings that live in the bundled npm toolchain.
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git \
 && apk upgrade --no-cache --available \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /root/.npm /root/.cache /var/cache/apk/*

COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY --from=client /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/src/index.js"]
