FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY telemetry-processor ./telemetry-processor
COPY config ./config
RUN mkdir -p /var/lib/smpp-telemetry && chown -R node:node /var/lib/smpp-telemetry /app
USER node
CMD ["node", "telemetry-processor/src/apps/index.mjs"]
