# ==============================================================================
# Dockerfile — Standalone MEC Edge Agent Node
# ==============================================================================
FROM node:18-alpine

WORKDIR /app

# Cache package installation
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=5001
ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0
ENV ORCHESTRATOR_URL=https://orchestrator-id88.onrender.com
ENV ORIGIN_URL=https://origin-server-1ge5.onrender.com
ENV NODE_LABEL=MEC-Edge-Agent
ENV DELAY_MS=5

EXPOSE 5001

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "server.js"]
