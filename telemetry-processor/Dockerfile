FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json pnpm-workspace.yaml ./
COPY telemetry-processor ./telemetry-processor
COPY telemetry-dashboard/query-api ./telemetry-dashboard/query-api
COPY telemetry-collector ./telemetry-collector
COPY telemetry-schema ./telemetry-schema
COPY packages ./packages
COPY tools ./tools
COPY deploy/bin ./deploy/bin
RUN npm install --include=dev --ignore-scripts && npm run build

FROM node:22-alpine
ARG VCS_REF=development
LABEL org.opencontainers.image.revision=$VCS_REF
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY telemetry-schema ./telemetry-schema
COPY contracts ./contracts
RUN mkdir -p /var/lib/smpp-telemetry/wal && chown -R node:node /var/lib/smpp-telemetry
USER node
CMD ["node", "dist/telemetry-processor/src/apps/index.js"]
