FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY telemetry-processor ./telemetry-processor
COPY telemetry-dashboard/query-api ./telemetry-dashboard/query-api
COPY telemetry-collector ./telemetry-collector
COPY telemetry-schema ./telemetry-schema
COPY contracts ./contracts
COPY packages ./packages
COPY tools ./tools
COPY deploy/bin ./deploy/bin
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund && npm run build

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ARG VCS_REF=development
LABEL org.opencontainers.image.revision=$VCS_REF
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
USER node
CMD ["node", "dist/telemetry-dashboard/query-api/src/index.js"]
