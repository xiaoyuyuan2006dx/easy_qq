FROM node:18-alpine

WORKDIR /app

# Set timezone to Shanghai (Node.js uses TZ env, no system tzdata needed)
ENV TZ=Asia/Shanghai

# Optional: set npm proxy via build args (--build-arg NPM_PROXY=http://host.docker.internal:7897)
ARG NPM_PROXY
ARG NPM_HTTPS_PROXY
RUN if [ -n "$NPM_PROXY" ]; then npm config set proxy "$NPM_PROXY"; fi
RUN if [ -n "$NPM_HTTPS_PROXY" ]; then npm config set https-proxy "$NPM_HTTPS_PROXY"; fi

# 复制依赖文件并安装（利用 layer cache，只有 package 变化时才重装）
COPY package*.json ./
RUN npm ci --omit=dev

# 复制源码和静态文件
COPY server.js ./
COPY public/ ./public/

EXPOSE 18080

# data/ 目录挂载卷，持久化 store.json / uploads / exports / local_files
VOLUME ["/app/data"]

CMD ["node", "server.js"]
