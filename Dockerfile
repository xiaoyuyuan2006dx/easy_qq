FROM node:22-alpine

WORKDIR /app

ENV TZ=Asia/Shanghai

# Install openssl (non-fatal: HTTPS disabled gracefully if unavailable)
RUN apk add --no-cache openssl || true

# npm proxy (optional build arg)
ARG NPM_PROXY
ARG NPM_HTTPS_PROXY

# Install deps & cleanup in one layer
COPY package*.json ./
RUN if [ -n "$NPM_PROXY" ]; then npm config set proxy "$NPM_PROXY"; fi && \
    if [ -n "$NPM_HTTPS_PROXY" ]; then npm config set https-proxy "$NPM_HTTPS_PROXY"; fi && \
    npm ci --omit=dev && \
    npm cache clean --force && \
    npm config delete proxy 2>/dev/null; npm config delete https-proxy 2>/dev/null; \
    rm -rf /tmp/* /root/.npm

# Copy app
COPY server.js ./
COPY server/ ./server/
COPY public/ ./public/

EXPOSE 18080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:18080/backend/health || exit 1

VOLUME ["/app/data"]

CMD ["node", "server.js"]
