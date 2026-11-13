# Standalone container for the cost-aware scheduler planning service.
# Build context is this directory (backend/scheduler).
FROM node:20-alpine

WORKDIR /app

# Install only production deps (express) using the lockfile-free manifest.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy the scheduler source (costModel, scheduler, router, providers, server).
COPY . .

ENV PORT=8080
EXPOSE 8080

# Drop to the non-root user that the node image ships with.
USER node

# Lightweight healthcheck hitting the service's own /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server-standalone.js"]
