// 加载环境变量
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDatabase } = require('./database');
const logger = require('./utils/logger');

// 确保日志目录存在
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// 路由
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const categoryRoutes = require('./routes/categories');
const orderRoutes = require('./routes/orders');
const cartRoutes = require('./routes/cart');
const uploadRoutes = require('./routes/upload');
const addressRoutes = require('./routes/addresses');
const payRoutes = require('./routes/pay');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// 请求日志中间件
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// 初始化数据库
initDatabase();
logger.info('数据库初始化完成');

// 启动订单超时回收任务（reaper）
// 关键链路：未支付订单到期后自动从 pending 推进到 closed，并把预占库存还给可售库存。
const orderReaper = require('./services/orderReaper');
orderReaper.start();

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/pay', payRoutes);

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '微信小程序电商API运行正常',
    env: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// 404处理
app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 全局错误处理
app.use((err, req, res, next) => {
  logger.error(`${req.method} ${req.path} - ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: '服务器内部错误' });
});

// 启动服务
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 后端服务启动成功`);
  logger.info(`📍 监听地址: http://0.0.0.0:${PORT}`);
  logger.info(`🌍 环境: ${process.env.NODE_ENV || 'development'}`);
});

// 优雅退出
process.on('SIGTERM', () => {
  logger.info('收到SIGTERM信号，准备关闭服务...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('未捕获的异常:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的Promise拒绝:', reason);
});
