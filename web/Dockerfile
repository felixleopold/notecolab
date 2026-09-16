FROM node:22-alpine AS plugin
WORKDIR /plugin
COPY package.json package-lock.json esbuild.config.mjs tsconfig.json ./
RUN npm ci
COPY src ./src
COPY manifest.json ./
RUN npm run build

FROM node:22-alpine AS builder
WORKDIR /app
COPY web/package.json web/package-lock.json web/.npmrc* ./
RUN npm ci --legacy-peer-deps
COPY web/ .
COPY --from=plugin /plugin/main.js public/downloads/main.js
COPY --from=plugin /plugin/manifest.json public/downloads/manifest.json
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=builder /app/.output .output
EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", ".output/server/index.mjs"]
