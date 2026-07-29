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
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
USER node
CMD ["node", "dist/telemetry-dashboard/query-api/src/index.js"]
