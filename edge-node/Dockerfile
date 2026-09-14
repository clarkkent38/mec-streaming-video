# ==============================================================================
# Dockerfile — Self-Registering MEC Edge Agent Node
# ==============================================================================
FROM node:18-alpine

WORKDIR /app

# Install production dependencies first (layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Default runtime environment variables
ENV PORT=5001
ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0
ENV ORCHESTRATOR_URL=http://host.docker.internal:5000
ENV ORIGIN_URL=http://host.docker.internal:3000
ENV NODE_LABEL=Edge-Node-Agent
ENV DELAY_MS=5

EXPOSE 5001

# Healthcheck to verify proxy readiness
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "server.js"]
