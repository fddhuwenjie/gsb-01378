const { db } = require('../database');
const logger = require('../utils/logger');

const ORDER_PAY_TIMEOUT_MINUTES = parseInt(process.env.ORDER_PAY_TIMEOUT_MINUTES || '15', 10);
const STOCK_OP_TYPES = {
  RESERVE: 'reserve',
  CONFIRM: 'confirm',
  RELEASE: 'release',
  ADMIN_ADJUST: 'admin_adjust'
};

function generateIdempotentKey(prefix, ...parts) {
  const crypto = require('crypto');
  const str = parts.join('_');
  return `${prefix}_${crypto.createHash('md5').update(str).digest('hex')}`;
}

function getAvailableStock(productId) {
  const product = db.prepare('SELECT stock, reserved_stock FROM products WHERE id = ?').get(productId);
  if (!product) return 0;
  return product.stock - product.reserved_stock;
}

function reserveStock(orderId, orderNo, items) {
  const reserveTransaction = db.transaction(() => {
    for (const item of items) {
      const logKey = generateIdempotentKey('reserve', orderId, item.product_id);
      const existingLog = db.prepare('SELECT id FROM stock_logs WHERE idempotent_key = ?').get(logKey);
      if (existingLog) {
        continue;
      }

      const product = db.prepare('SELECT id, name, stock, reserved_stock, version FROM products WHERE id = ?').get(item.product_id);
      if (!product) {
        throw new Error(`商品 ${item.product_id} 不存在`);
      }

      const availableStock = product.stock - product.reserved_stock;
      if (availableStock < item.quantity) {
        throw new Error(`商品 ${product.name} 库存不足，可售库存：${availableStock}`);
      }

      const updateResult = db.prepare(`
        UPDATE products 
        SET reserved_stock = reserved_stock + ?, version = version + 1
        WHERE id = ? AND (stock - reserved_stock) >= ? AND version = ?
      `).run(item.quantity, item.product_id, item.quantity, product.version);

      if (updateResult.changes === 0) {
        throw new Error(`商品 ${product.name} 库存预占失败，请重试`);
      }

      db.prepare(`
        INSERT INTO stock_logs (order_id, order_no, product_id, product_name, quantity, type, idempotent_key, remark)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(orderId, orderNo, item.product_id, product.name, item.quantity, STOCK_OP_TYPES.RESERVE, logKey, '下单预占库存');
    }

    db.prepare('UPDATE orders SET stock_locked = 1 WHERE id = ?').run(orderId);
  });

  reserveTransaction();
  logger.info(`库存预占完成: 订单 ${orderNo}`);
}

function confirmStockDeduction(orderId, orderNo, transactionId = null) {
  const order = db.prepare('SELECT id, status, stock_locked, stock_processed FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    throw new Error('订单不存在');
  }

  if (order.stock_processed === 1) {
    logger.info(`订单 ${orderNo} 库存已处理，跳过确认`);
    return;
  }

  if (order.status !== 'pending' && order.status !== 'paid') {
    throw new Error(`订单状态 ${order.status} 不允许确认库存扣减`);
  }

  if (order.stock_locked !== 1) {
    logger.warn(`订单 ${orderNo} 库存未锁定，尝试正常扣减`);
  }

  const confirmTransaction = db.transaction(() => {
    const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(orderId);

    for (const item of items) {
      const logKey = generateIdempotentKey('confirm', orderId, item.product_id);
      const existingLog = db.prepare('SELECT id FROM stock_logs WHERE idempotent_key = ?').get(logKey);
      if (existingLog) {
        continue;
      }

      const product = db.prepare('SELECT id, name, stock, reserved_stock FROM products WHERE id = ?').get(item.product_id);
      if (!product) {
        throw new Error(`商品 ${item.product_id} 不存在`);
      }

      if (product.reserved_stock < item.quantity) {
        logger.warn(`商品 ${product.name} 预占库存异常，尝试修正: reserved=${product.reserved_stock}, need=${item.quantity}`);
      }

      const deductQty = Math.min(item.quantity, product.stock);
      const releaseReservedQty = Math.min(item.quantity, product.reserved_stock);
      db.prepare(`
        UPDATE products 
        SET stock = stock - ?, reserved_stock = reserved_stock - ?, sales = sales + ?
        WHERE id = ?
      `).run(deductQty, releaseReservedQty, item.quantity, item.product_id);

      db.prepare(`
        INSERT INTO stock_logs (order_id, order_no, product_id, product_name, quantity, type, idempotent_key, remark)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId, orderNo, item.product_id, product.name, item.quantity,
        STOCK_OP_TYPES.CONFIRM, logKey, transactionId ? `支付成功 ${transactionId}` : '支付成功'
      );
    }

    db.prepare('UPDATE orders SET stock_processed = 1, paid_at = CURRENT_TIMESTAMP WHERE id = ?').run(orderId);
  });

  confirmTransaction();
  logger.info(`库存扣减确认完成: 订单 ${orderNo}`);
}

function releaseStock(orderId, orderNo, reason = '主动取消') {
  const order = db.prepare('SELECT id, status, stock_locked, stock_processed FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    throw new Error('订单不存在');
  }

  if (order.stock_processed === 1) {
    logger.warn(`订单 ${orderNo} 库存已处理（已支付），不允许释放`);
    throw new Error('订单已支付，不能释放库存');
  }

  if (order.stock_locked !== 1) {
    logger.info(`订单 ${orderNo} 库存未锁定，无需释放`);
    db.prepare('UPDATE orders SET cancelled_at = CURRENT_TIMESTAMP WHERE id = ? AND status != ?').run(orderId, 'paid');
    return;
  }

  const releaseTransaction = db.transaction(() => {
    const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(orderId);
    let allReleased = true;

    for (const item of items) {
      const logKey = generateIdempotentKey('release', orderId, item.product_id);
      const existingLog = db.prepare('SELECT id FROM stock_logs WHERE idempotent_key = ?').get(logKey);
      if (existingLog) {
        continue;
      }

      const product = db.prepare('SELECT id, name, reserved_stock FROM products WHERE id = ?').get(item.product_id);
      if (!product) {
        allReleased = false;
        logger.error(`释放库存失败: 商品 ${item.product_id} 不存在，订单 ${orderNo}`);
        continue;
      }

      const releaseQty = Math.min(item.quantity, product.reserved_stock);
      if (releaseQty < item.quantity) {
        logger.warn(`商品 ${product.name} 预占库存不足，预占=${product.reserved_stock}, 需要=${item.quantity}`);
        allReleased = false;
      }

      const updateResult = db.prepare(`
        UPDATE products 
        SET reserved_stock = reserved_stock - ?
        WHERE id = ? AND reserved_stock >= ?
      `).run(releaseQty, item.product_id, releaseQty);

      if (updateResult.changes > 0) {
        db.prepare(`
          INSERT INTO stock_logs (order_id, order_no, product_id, product_name, quantity, type, idempotent_key, remark)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          orderId, orderNo, item.product_id, product.name, releaseQty,
          STOCK_OP_TYPES.RELEASE, logKey, reason
        );
      }
    }

    if (allReleased) {
      db.prepare('UPDATE orders SET stock_locked = 0, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?').run(orderId);
    }

    return allReleased;
  });

  const result = releaseTransaction();
  logger.info(`库存释放${result ? '完成' : '部分完成'}: 订单 ${orderNo}, 原因: ${reason}`);
  return result;
}

function processExpiredOrders() {
  const expireTime = new Date(Date.now()).toISOString();
  
  const expiredOrders = db.prepare(`
    SELECT id, order_no, user_id, total_amount 
    FROM orders 
    WHERE status = 'pending' 
    AND pay_expire_time IS NOT NULL 
    AND pay_expire_time <= ?
    AND stock_locked = 1
  `).all(expireTime);

  logger.info(`扫描到 ${expiredOrders.length} 个超时待支付订单`);

  let releasedCount = 0;
  for (const order of expiredOrders) {
    try {
      const statusCheck = db.prepare(`SELECT id, status, stock_locked FROM orders WHERE id = ? AND status = 'pending' AND stock_locked = 1`).get(order.id);
      if (!statusCheck) {
        continue;
      }

      const tx = db.transaction(() => {
        const updateResult = db.prepare(`
          UPDATE orders SET status = 'timeout', cancelled_at = CURRENT_TIMESTAMP 
          WHERE id = ? AND status = 'pending' AND stock_locked = 1
        `).run(order.id);
        
        if (updateResult.changes === 0) {
          return false;
        }
        return true;
      });

      const updated = tx();
      if (updated) {
        releaseStock(order.id, order.order_no, '支付超时自动取消');
        releasedCount++;
        logger.info(`超时订单已关闭: ${order.order_no}`);
      }
    } catch (err) {
      logger.error(`处理超时订单失败 ${order.order_no}:`, err.message);
    }
  }

  return { total: expiredOrders.length, released: releasedCount };
}

function getStockSummary(productId) {
  const product = db.prepare('SELECT id, name, stock, reserved_stock, sales FROM products WHERE id = ?').get(productId);
  if (!product) return null;
  
  return {
    product_id: product.id,
    name: product.name,
    total_stock: product.stock,
    reserved_stock: product.reserved_stock,
    available_stock: product.stock - product.reserved_stock,
    sold_stock: product.sales
  };
}

module.exports = {
  STOCK_OP_TYPES,
  ORDER_PAY_TIMEOUT_MINUTES,
  generateIdempotentKey,
  getAvailableStock,
  reserveStock,
  confirmStockDeduction,
  releaseStock,
  processExpiredOrders,
  getStockSummary
};
