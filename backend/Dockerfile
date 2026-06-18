# 使用多阶段构建
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖（包括编译原生模块所需的工具）
RUN apk add --no-cache python3 make g++ && \
    npm install --only=production

# 生产阶段
FROM --platform=$TARGETPLATFORM node:20-alpine

WORKDIR /app

# 安装运行时依赖
RUN apk add --no-cache python3 make g++

# 从构建阶段复制 node_modules
COPY --from=builder /app/node_modules ./node_modules

# 复制源代码
COPY . .

# 创建数据目录和上传目录
RUN mkdir -p data uploads

# 暴露端口
EXPOSE 3000

# 健康检查 (使用 node 进行检查)
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# 启动应用
CMD ["npm", "start"]
