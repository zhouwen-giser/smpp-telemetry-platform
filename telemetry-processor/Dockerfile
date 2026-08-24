FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder
WORKDIR /app
COPY package.json package-lock.json pnpm-lock.yaml tsconfig.json pnpm-workspace.yaml ./
COPY telemetry-processor ./telemetry-processor
COPY telemetry-dashboard/query-api ./telemetry-dashboard/query-api
COPY telemetry-collector ./telemetry-collector
COPY telemetry-schema ./telemetry-schema
COPY packages ./packages
COPY tools ./tools
COPY deploy/bin ./deploy/bin
COPY vendor/npm-cache ./vendor/npm-cache
RUN node tools/vendor-npm-cache.mjs verify \
      --npm-lock package-lock.json --pnpm-lock pnpm-lock.yaml \
      --cache /app/vendor/npm-cache \
    && npm ci --offline --include=dev --ignore-scripts \
      --no-audit --no-fund --no-update-notifier \
      --cache=/app/vendor/npm-cache \
    && npm run build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ARG VCS_REF=development
LABEL org.opencontainers.image.revision=$VCS_REF
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY telemetry-schema ./telemetry-schema
COPY contracts ./dist/contracts
RUN mkdir -p /var/lib/smpp-telemetry/wal && chown -R node:node /var/lib/smpp-telemetry
USER node
CMD ["node", "dist/telemetry-processor/src/apps/index.js"]
