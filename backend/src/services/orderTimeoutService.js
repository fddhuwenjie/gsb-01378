const { db, ORDER_TIMEOUT_MINUTES } = require('../database');
const { releaseStockForOrder } = require('./stockService');
const logger = require('../utils/logger');

function processTimeoutOrders() {
  const now = new Date().toISOString();
  
  const timeoutOrders = db.prepare(`
    SELECT id, order_no 
    FROM orders 
    WHERE status = 'pending' 
      AND expire_at IS NOT NULL 
      AND expire_at <= ?
      AND stock_released = 0
    ORDER BY expire_at ASC
    LIMIT 100
  `).all(now);

  if (timeoutOrders.length === 0) {
    return 0;
  }

  logger.info(`发现 ${timeoutOrders.length} 个超时待处理订单`);

  let successCount = 0;
  for (const order of timeoutOrders) {
    try {
      const timeoutTransaction = db.transaction((orderId) => {
        const lockedOrder = db.prepare(`
          SELECT id, status, stock_reserved, stock_released, stock_confirmed 
          FROM orders 
          WHERE id = ? 
        `).get(orderId);

        if (!lockedOrder || lockedOrder.status !== 'pending' || lockedOrder.stock_released === 1) {
          return;
        }

        if (lockedOrder.stock_confirmed === 1) {
          logger.warn(`订单 ${order.order_no} 库存已确认但状态未更新，跳过释放`);
          return;
        }

        releaseStockForOrder(orderId);

        const updateResult = db.prepare(`
          UPDATE orders 
          SET status = 'timeout', 
              cancelled_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP 
          WHERE id = ? AND status = 'pending' AND stock_released = 1
        `).run(orderId);

        if (updateResult.changes === 0) {
          const currentOrder = db.prepare('SELECT id, status, stock_released FROM orders WHERE id = ?').get(orderId);
          if (currentOrder && currentOrder.status === 'timeout' && currentOrder.stock_released === 1) {
            return;
          }
          throw new Error('订单状态更新失败');
        }
      });

      timeoutTransaction(order.id);
      successCount++;
      logger.info(`订单 ${order.order_no} 超时处理完成，库存已释放`);
    } catch (err) {
      logger.error(`处理超时订单 ${order.order_no} 失败:`, err);
    }
  }

  logger.info(`超时订单处理完成: 成功 ${successCount}/${timeoutOrders.length}`);
  return successCount;
}

function startOrderTimeoutScheduler() {
  const intervalMs = 60 * 1000;
  
  logger.info(`订单超时检查任务已启动，检查间隔: ${intervalMs / 1000}秒，超时时间: ${ORDER_TIMEOUT_MINUTES}分钟`);
  
  setInterval(() => {
    try {
      processTimeoutOrders();
    } catch (err) {
      logger.error('超时订单检查任务异常:', err);
    }
  }, intervalMs);

  setTimeout(() => {
    try {
      processTimeoutOrders();
    } catch (err) {
      logger.error('启动时超时订单检查异常:', err);
    }
  }, 5000);
}

function calculateExpireTime() {
  const expireAt = new Date();
  expireAt.setMinutes(expireAt.getMinutes() + ORDER_TIMEOUT_MINUTES);
  return expireAt.toISOString();
}

function getOrderTimeRemaining(order) {
  if (order.status !== 'pending' || !order.expire_at) {
    return null;
  }

  const expireTime = new Date(order.expire_at).getTime();
  const now = Date.now();
  const remainingMs = expireTime - now;

  if (remainingMs <= 0) {
    return {
      expired: true,
      remainingSeconds: 0,
      formatted: '已过期'
    };
  }

  const remainingSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  return {
    expired: false,
    remainingSeconds,
    remainingMinutes: minutes,
    formatted: `${minutes}分${seconds.toString().padStart(2, '0')}秒`
  };
}

module.exports = {
  processTimeoutOrders,
  startOrderTimeoutScheduler,
  calculateExpireTime,
  getOrderTimeRemaining
};
