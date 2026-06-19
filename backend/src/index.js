require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDatabase, db } = require('./database');
const logger = require('./utils/logger');
const inventoryService = require('./services/inventoryService');

const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

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

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

initDatabase();
logger.info('数据库初始化完成');

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/pay', payRoutes);

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '微信小程序电商API运行正常',
    env: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    stock_system: 'enabled',
    pay_timeout_minutes: inventoryService.ORDER_PAY_TIMEOUT_MINUTES
  });
});

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((err, req, res, next) => {
  logger.error(`${req.method} ${req.path} - ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: '服务器内部错误' });
});

const ORDER_TIMEOUT_CHECK_INTERVAL = parseInt(process.env.ORDER_TIMEOUT_CHECK_INTERVAL || '30', 10) * 1000;

function startOrderTimeoutChecker() {
  const check = () => {
    try {
      const result = inventoryService.processExpiredOrders();
      if (result.total > 0) {
        logger.info(`定时扫描超时订单: 发现${result.total}个，已释放${result.released}个`);
      }
    } catch (err) {
      logger.error('定时扫描超时订单失败:', err.message);
    }
  };

  setTimeout(() => {
    check();
    setInterval(check, ORDER_TIMEOUT_CHECK_INTERVAL);
  }, 5000);

  logger.info(`✅ 订单超时检查已启动，扫描间隔: ${ORDER_TIMEOUT_CHECK_INTERVAL/1000}秒，支付超时: ${inventoryService.ORDER_PAY_TIMEOUT_MINUTES}分钟`);
}

function startServer() {
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 后端服务启动成功`);
    logger.info(`📍 监听地址: http://0.0.0.0:${PORT}`);
    logger.info(`🌍 环境: ${process.env.NODE_ENV || 'development'}`);
    startOrderTimeoutChecker();
  });
}

setTimeout(startServer, 100);

process.on('SIGTERM', () => {
  logger.info('收到SIGTERM信号，准备关闭服务...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('收到SIGINT信号，准备关闭服务...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('未捕获的异常:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的Promise拒绝:', reason);
});
