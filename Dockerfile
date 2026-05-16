FROM node:18-alpine

WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制源码和静态文件
COPY . .

# 创建数据目录
RUN mkdir -p /app/data/uploads /app/data/exports

EXPOSE 18080

CMD ["node", "server.js"]
