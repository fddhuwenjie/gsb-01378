const { db } = require('../database');
const logger = require('../utils/logger');

const ORDER_TIMEOUT_MINUTES = parseInt(process.env.ORDER_TIMEOUT_MINUTES || '30', 10);
const ORDER_TIMEOUT_MS = ORDER_TIMEOUT_MINUTES * 60 * 1000;

function generateOrderNo() {
  const date = new Date();
  const dateStr = date.getFullYear().toString() +
    (date.getMonth() + 1).toString().padStart(2, '0') +
    date.getDate().toString().padStart(2, '0') +
    date.getHours().toString().padStart(2, '0') +
    date.getMinutes().toString().padStart(2, '0') +
    date.getSeconds().toString().padStart(2, '0');
  return dateStr + Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
}

function enrichProductWithStock(product) {
  if (!product) return product;
  const availableStock = Math.max(0, (product.total_stock || 0) - (product.locked_stock || 0) - (product.sold_stock || 0));
  return {
    ...product,
    available_stock: availableStock,
    stock: availableStock
  };
}

function getStockFlags(orderId) {
  let flags = db.prepare('SELECT * FROM stock_processed_flags WHERE order_id = ?').get(orderId);
  if (!flags) {
    db.prepare('INSERT OR IGNORE INTO stock_processed_flags (order_id, order_no, locked, confirmed, released) VALUES (?, ?, 0, 0, 0)')
      .run(orderId, '');
    flags = db.prepare('SELECT * FROM stock_processed_flags WHERE order_id = ?').get(orderId);
  }
  return flags;
}

function writeStockLog(productId, orderId, orderNo, opType, qty, before, after, idempotencyKey, remark) {
  db.prepare(`
    INSERT INTO stock_logs (
      product_id, order_id, order_no, operation_type, quantity,
      before_total_stock, before_locked_stock, before_sold_stock,
      after_total_stock, after_locked_stock, after_sold_stock,
      idempotency_key, remark
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    productId, orderId, orderNo, opType, qty,
    before.total_stock, before.locked_stock, before.sold_stock,
    after.total_stock, after.locked_stock, after.sold_stock,
    idempotencyKey, remark
  );
}

function createOrderWithStockLock({ userId, items, address, receiverName, receiverPhone, remark, idempotencyKey }) {
  if (!items || items.length === 0) {
    throw new Error('订单商品不能为空');
  }

  if (idempotencyKey) {
    const existing = db.prepare(`
      SELECT o.* FROM orders o 
      WHERE o.idempotency_key = ? AND o.user_id = ?
    `).get(idempotencyKey, userId);
    if (existing) {
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(existing.id);
      return {
        orderId: existing.id,
        orderNo: existing.order_no,
        payExpireTime: existing.pay_expire_time,
        timeoutMinutes: ORDER_TIMEOUT_MINUTES,
        duplicated: true,
        items
      };
    }
  }

  const tx = db.transaction(() => {
    const productIds = [...new Set(items.map(i => i.product_id))];
    const products = {};
    for (const pid of productIds) {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(pid);
      if (!p) throw new Error(`商品 ${pid} 不存在或已下架`);
      products[pid] = p;
    }

    let totalAmount = 0;
    for (const item of items) {
      const p = products[item.product_id];
      const qty = parseInt(item.quantity, 10);
      if (!qty || qty <= 0) throw new Error(`商品 ${p.name} 数量无效`);
      
      const available = (p.total_stock || 0) - (p.locked_stock || 0) - (p.sold_stock || 0);
      if (available < qty) {
        throw new Error(`商品 ${p.name} 库存不足，仅剩 ${available} 件`);
      }
      totalAmount += p.price * qty;
    }

    const orderNo = generateOrderNo();
    const payExpireTime = new Date(Date.now() + ORDER_TIMEOUT_MS).toISOString();

    const orderResult = db.prepare(`
      INSERT INTO orders (
        order_no, user_id, total_amount, status, 
        pay_expire_time, address, receiver_name, receiver_phone, 
        remark, idempotency_key
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      orderNo, userId, totalAmount, payExpireTime,
      address || '', receiverName || '', receiverPhone || '',
      remark || '', idempotencyKey || null
    );

    const orderId = orderResult.lastInsertRowid;

    db.prepare('INSERT INTO stock_processed_flags (order_id, order_no, locked, confirmed, released) VALUES (?, ?, 0, 0, 0)')
      .run(orderId, orderNo);

    for (const item of items) {
      const p = products[item.product_id];
      const qty = parseInt(item.quantity, 10);

      const before = { total_stock: p.total_stock, locked_stock: p.locked_stock, sold_stock: p.sold_stock };
      
      const updateResult = db.prepare(`
        UPDATE products 
        SET locked_stock = locked_stock + ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND (total_stock - locked_stock - sold_stock) >= ?
      `).run(qty, item.product_id, qty);

      if (updateResult.changes === 0) {
        throw new Error(`商品 ${p.name} 库存不足（并发冲突），请重试`);
      }

      const afterProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      const after = { total_stock: afterProduct.total_stock, locked_stock: afterProduct.locked_stock, sold_stock: afterProduct.sold_stock };

      db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, product_image, quantity, price)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(orderId, item.product_id, p.name, p.image, qty, p.price);

      writeStockLog(
        item.product_id, orderId, orderNo, 'lock', qty, before, after, idempotencyKey,
        `下单预占库存，订单号: ${orderNo}`
      );
    }

    db.prepare('UPDATE stock_processed_flags SET locked = 1, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?')
      .run(orderId);

    return { orderId, orderNo, payExpireTime };
  });

  try {
    const result = tx();
    logger.info(`[StockService] 订单创建成功: ${result.orderNo}, 超时时间: ${ORDER_TIMEOUT_MINUTES}分钟`);
    return {
      ...result,
      timeoutMinutes: ORDER_TIMEOUT_MINUTES
    };
  } catch (err) {
    logger.error(`[StockService] 创建订单失败: ${err.message}`);
    throw err;
  }
}

function confirmOrderPaid(orderNo) {
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
  if (!order) {
    throw new Error('订单不存在');
  }

  if (order.status === 'paid' || order.status === 'shipped' || order.status === 'completed') {
    return { alreadyProcessed: true, orderId: order.id };
  }

  if (order.status === 'cancelled' || order.status === 'timeout') {
    throw new Error('订单已关闭，无法确认支付');
  }

  const flags = getStockFlags(order.id);
  if (flags.confirmed === 1) {
    db.prepare(`UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`)
      .run(order.id);
    return { alreadyProcessed: true, orderId: order.id };
  }

  const tx = db.transaction(() => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);

    for (const item of items) {
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!p) continue;

      const before = { total_stock: p.total_stock, locked_stock: p.locked_stock, sold_stock: p.sold_stock };

      const updateResult = db.prepare(`
        UPDATE products 
        SET locked_stock = locked_stock - ?, sold_stock = sold_stock + ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND locked_stock >= ?
      `).run(item.quantity, item.quantity, item.product_id, item.quantity);

      if (updateResult.changes === 0) {
        logger.warn(`[StockService] 订单 ${orderNo} 商品 ${item.product_id} 库存确认时锁定库存不足，跳过该商品`);
        continue;
      }

      const afterProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      const after = { total_stock: afterProduct.total_stock, locked_stock: afterProduct.locked_stock, sold_stock: afterProduct.sold_stock };

      writeStockLog(
        item.product_id, order.id, orderNo, 'confirm', item.quantity, before, after, null,
        `支付成功，预占转已售，订单号: ${orderNo}`
      );
    }

    db.prepare(`
      UPDATE orders 
      SET status = 'paid', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ? AND status = 'pending'
    `).run(order.id);

    db.prepare('UPDATE stock_processed_flags SET confirmed = 1, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?')
      .run(order.id);
  });

  tx();
  logger.info(`[StockService] 订单支付确认完成: ${orderNo}`);
  return { alreadyProcessed: false, orderId: order.id };
}

function cancelOrder(orderId, userId) {
  let order;
  if (userId) {
    order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
  } else {
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  }

  if (!order) {
    throw new Error('订单不存在');
  }

  if (order.status === 'cancelled') {
    return { alreadyProcessed: true };
  }

  if (order.status === 'timeout') {
    return releaseOrderStock(order.id, order.order_no, 'user_cancel');
  }

  if (order.status !== 'pending') {
    throw new Error(`订单状态为 ${order.status}，无法取消`);
  }

  return releaseOrderStock(order.id, order.order_no, 'user_cancel');
}

function timeoutOrder(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    throw new Error('订单不存在');
  }

  if (order.status !== 'pending') {
    return { alreadyProcessed: true };
  }

  if (order.pay_expire_time && new Date(order.pay_expire_time) > new Date()) {
    return { notExpired: true };
  }

  return releaseOrderStock(orderId, order.order_no, 'timeout');
}

function releaseOrderStock(orderId, orderNo, reason) {
  const flags = getStockFlags(orderId);
  if (flags.released === 1) {
    const newStatus = reason === 'timeout' ? 'timeout' : 'cancelled';
    db.prepare(`UPDATE orders SET status = ?, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(newStatus, orderId);
    return { alreadyProcessed: true };
  }

  if (flags.confirmed === 1) {
    throw new Error('订单已支付，无法释放库存');
  }

  const tx = db.transaction(() => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);

    for (const item of items) {
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!p) continue;

      const before = { total_stock: p.total_stock, locked_stock: p.locked_stock, sold_stock: p.sold_stock };

      const updateResult = db.prepare(`
        UPDATE products 
        SET locked_stock = locked_stock - ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND locked_stock >= ?
      `).run(item.quantity, item.product_id, item.quantity);

      if (updateResult.changes === 0) {
        logger.warn(`[StockService] 订单 ${orderNo} 商品 ${item.product_id} 释放时锁定库存不足`);
        continue;
      }

      const afterProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      const after = { total_stock: afterProduct.total_stock, locked_stock: afterProduct.locked_stock, sold_stock: afterProduct.sold_stock };

      const remark = reason === 'timeout' 
        ? `订单超时自动释放，订单号: ${orderNo}` 
        : `用户取消订单释放库存，订单号: ${orderNo}`;

      writeStockLog(
        item.product_id, orderId, orderNo, 'release', item.quantity, before, after, null, remark
      );
    }

    const newStatus = reason === 'timeout' ? 'timeout' : 'cancelled';
    db.prepare(`
      UPDATE orders 
      SET status = ?, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ? AND status = 'pending'
    `).run(newStatus, orderId);

    db.prepare('UPDATE stock_processed_flags SET released = 1, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?')
      .run(orderId);
  });

  tx();
  logger.info(`[StockService] 订单库存已释放: ${orderNo}, 原因: ${reason}`);
  return { alreadyProcessed: false };
}

function scanAndCloseTimeoutOrders() {
  const now = new Date().toISOString();
  const expiredOrders = db.prepare(`
    SELECT id, order_no FROM orders 
    WHERE status = 'pending' 
    AND pay_expire_time IS NOT NULL 
    AND pay_expire_time < ?
  `).all(now);

  let closedCount = 0;
  for (const order of expiredOrders) {
    try {
      timeoutOrder(order.id);
      closedCount++;
    } catch (err) {
      logger.error(`[StockService] 关闭超时订单 ${order.order_no} 失败: ${err.message}`);
    }
  }

  if (closedCount > 0) {
    logger.info(`[StockService] 扫描完成，自动关闭 ${closedCount} 个超时订单`);
  }
  return closedCount;
}

let timeoutCheckerInterval = null;

function startTimeoutChecker(intervalMs = 60000) {
  scanAndCloseTimeoutOrders();
  timeoutCheckerInterval = setInterval(() => {
    try {
      scanAndCloseTimeoutOrders();
    } catch (err) {
      logger.error('[StockService] 超时扫描任务异常:', err);
    }
  }, intervalMs);
  logger.info(`[StockService] 订单超时检查器已启动，间隔 ${intervalMs / 1000} 秒，超时时间 ${ORDER_TIMEOUT_MINUTES} 分钟`);
  return timeoutCheckerInterval;
}

function stopTimeoutChecker() {
  if (timeoutCheckerInterval) {
    clearInterval(timeoutCheckerInterval);
    timeoutCheckerInterval = null;
    logger.info('[StockService] 订单超时检查器已停止');
  }
}

function getStockLogs(productId, page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  let sql = 'SELECT * FROM stock_logs';
  const params = [];
  if (productId) {
    sql += ' WHERE product_id = ?';
    params.push(productId);
  }
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(...params);
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  const list = db.prepare(sql).all(...params);
  return { list, total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / limit) };
}

function migrateOldData() {
  try {
    const products = db.prepare('SELECT id, name, total_stock, locked_stock, sold_stock FROM products').all();
    let migratedCount = 0;
    for (const p of products) {
      const total = p.total_stock || 0;
      const locked = Math.max(0, p.locked_stock || 0);
      let sold = Math.max(0, p.sold_stock || 0);
      
      if (locked + sold > total) {
        sold = Math.max(0, total - locked);
        db.prepare('UPDATE products SET locked_stock = ?, sold_stock = ? WHERE id = ?')
          .run(locked, sold, p.id);
        migratedCount++;
        logger.warn(`[StockService] 商品「${p.name}」库存已修复: sold_stock 调整为 ${sold}，确保不超过总库存`);
      } else if (locked < 0 || sold < 0) {
        db.prepare('UPDATE products SET locked_stock = ?, sold_stock = ? WHERE id = ?')
          .run(locked, sold, p.id);
        migratedCount++;
      }
    }
    
    const pendingOrders = db.prepare(`
      SELECT id, order_no FROM orders WHERE status = 'pending'
    `).all();
    for (const o of pendingOrders) {
      db.prepare('INSERT OR IGNORE INTO stock_processed_flags (order_id, order_no, locked, confirmed, released) VALUES (?, ?, 1, 0, 0)')
        .run(o.id, o.order_no);
    }
    
    const paidOrders = db.prepare(`
      SELECT id, order_no FROM orders WHERE status IN ('paid', 'shipped', 'completed')
    `).all();
    for (const o of paidOrders) {
      db.prepare('INSERT OR IGNORE INTO stock_processed_flags (order_id, order_no, locked, confirmed, released) VALUES (?, ?, 1, 1, 0)')
        .run(o.id, o.order_no);
    }
    
    const cancelledOrders = db.prepare(`
      SELECT id, order_no FROM orders WHERE status IN ('cancelled', 'timeout')
    `).all();
    for (const o of cancelledOrders) {
      db.prepare('INSERT OR IGNORE INTO stock_processed_flags (order_id, order_no, locked, confirmed, released) VALUES (?, ?, 1, 0, 1)')
        .run(o.id, o.order_no);
    }
    
    if (migratedCount > 0) {
      logger.info(`[StockService] 数据迁移完成，修复了 ${migratedCount} 个商品的库存数据`);
    }
  } catch (err) {
    logger.error('[StockService] 数据迁移异常:', err);
  }
}

module.exports = {
  generateOrderNo,
  enrichProductWithStock,
  createOrderWithStockLock,
  confirmOrderPaid,
  cancelOrder,
  timeoutOrder,
  releaseOrderStock,
  scanAndCloseTimeoutOrders,
  startTimeoutChecker,
  stopTimeoutChecker,
  getStockLogs,
  migrateOldData,
  ORDER_TIMEOUT_MINUTES,
  ORDER_TIMEOUT_MS
};
