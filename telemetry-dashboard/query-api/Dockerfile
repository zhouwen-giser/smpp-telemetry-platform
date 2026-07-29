FROM node:22-alpine
WORKDIR /app
COPY telemetry-dashboard/query-api ./telemetry-dashboard/query-api
USER node
CMD ["node", "telemetry-dashboard/query-api/src/index.mjs"]
