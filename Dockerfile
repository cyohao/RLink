FROM node:22-alpine

# 时区：让 {{now}} 返回北京时间
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

# 以非 root 用户运行，配置文件保存在 /app/data
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/__health || exit 1
CMD ["node", "src/index.js"]
