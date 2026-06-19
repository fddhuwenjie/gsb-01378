const crypto = require('crypto');
const { db } = require('../database');

function generateIdempotentKey(orderId, productId, operationType) {
  return crypto.createHash('md5').update(`${orderId}:${productId}:${operationType}`).digest('hex');
}

function reserveStockForOrder(orderId, items) {
  const reserveTransaction = db.transaction((orderId, items) => {
    for (const item of items) {
      const idempotentKey = generateIdempotentKey(orderId, item.product_id, 'reserve');
      
      const existingOp = db.prepare('SELECT id FROM stock_operations WHERE idempotent_key = ?').get(idempotentKey);
      if (existingOp) {
        continue;
      }

      const product = db.prepare('SELECT id, available_stock, reserved_stock, version FROM products WHERE id = ? AND status = 1').get(item.product_id);
      if (!product) {
        throw new Error(`商品ID ${item.product_id} 不存在或已下架`);
      }

      if (product.available_stock < item.quantity) {
        throw new Error(`商品库存不足`);
      }

      const updateResult = db.prepare(`
        UPDATE products 
        SET available_stock = available_stock - ?, 
            reserved_stock = reserved_stock + ?,
            version = version + 1
        WHERE id = ? AND available_stock >= ? AND version = ?
      `).run(item.quantity, item.quantity, item.product_id, item.quantity, product.version);

      if (updateResult.changes === 0) {
        throw new Error(`并发冲突，请重试`);
      }

      db.prepare(`
        INSERT INTO stock_operations (order_id, order_no, product_id, operation_type, quantity, idempotent_key)
        SELECT ?, o.order_no, ?, 'reserve', ?, ?
        FROM orders o WHERE o.id = ?
      `).run(orderId, item.product_id, item.quantity, idempotentKey, orderId);
    }

    const reserveMarkResult = db.prepare(`
      UPDATE orders 
      SET stock_reserved = 1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ? AND stock_reserved = 0
    `).run(orderId);

    if (reserveMarkResult.changes === 0) {
      const checkOrder = db.prepare('SELECT id, stock_reserved FROM orders WHERE id = ?').get(orderId);
      if (!checkOrder || checkOrder.stock_reserved !== 1) {
        throw new Error('库存预占标记更新失败');
      }
    }
  });

  reserveTransaction(orderId, items);
}

function confirmStockForOrder(orderId) {
  const confirmTransaction = db.transaction((orderId) => {
    const order = db.prepare('SELECT id, status, stock_reserved, stock_confirmed FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      throw new Error('订单不存在');
    }
    if (order.stock_confirmed === 1) {
      return;
    }
    if (order.stock_reserved !== 1) {
      throw new Error('库存未预占，无法确认');
    }

    const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(orderId);

    for (const item of items) {
      const idempotentKey = generateIdempotentKey(orderId, item.product_id, 'confirm');
      
      const existingOp = db.prepare('SELECT id FROM stock_operations WHERE idempotent_key = ?').get(idempotentKey);
      if (existingOp) {
        continue;
      }

      const product = db.prepare('SELECT id, reserved_stock, sold_stock, version FROM products WHERE id = ?').get(item.product_id);
      if (!product) {
        throw new Error(`商品ID ${item.product_id} 不存在`);
      }

      const updateResult = db.prepare(`
        UPDATE products 
        SET reserved_stock = reserved_stock - ?, 
            sold_stock = sold_stock + ?,
            version = version + 1
        WHERE id = ? AND reserved_stock >= ? AND version = ?
      `).run(item.quantity, item.quantity, item.product_id, item.quantity, product.version);

      if (updateResult.changes === 0) {
        throw new Error(`库存确认失败`);
      }

      db.prepare(`
        INSERT INTO stock_operations (order_id, order_no, product_id, operation_type, quantity, idempotent_key)
        SELECT ?, o.order_no, ?, 'confirm', ?, ?
        FROM orders o WHERE o.id = ?
      `).run(orderId, item.product_id, item.quantity, idempotentKey, orderId);
    }

    const confirmMarkResult = db.prepare(`
      UPDATE orders 
      SET stock_confirmed = 1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ? AND stock_confirmed = 0 AND stock_reserved = 1
    `).run(orderId);

    if (confirmMarkResult.changes === 0) {
      const checkOrder = db.prepare('SELECT id, stock_confirmed FROM orders WHERE id = ?').get(orderId);
      if (!checkOrder || checkOrder.stock_confirmed !== 1) {
        throw new Error('库存确认标记更新失败');
      }
    }
  });

  confirmTransaction(orderId);
}

function releaseStockForOrder(orderId, reason = 'cancel') {
  const releaseTransaction = db.transaction((orderId) => {
    const order = db.prepare('SELECT id, status, stock_reserved, stock_released, stock_confirmed FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      throw new Error('订单不存在');
    }
    if (order.stock_released === 1) {
      return;
    }
    if (order.stock_confirmed === 1) {
      throw new Error('订单已支付，库存无法释放');
    }
    if (order.stock_reserved !== 1) {
      return;
    }

    const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(orderId);

    for (const item of items) {
      const idempotentKey = generateIdempotentKey(orderId, item.product_id, 'release');
      
      const existingOp = db.prepare('SELECT id FROM stock_operations WHERE idempotent_key = ?').get(idempotentKey);
      if (existingOp) {
        continue;
      }

      const product = db.prepare('SELECT id, available_stock, reserved_stock, version FROM products WHERE id = ?').get(item.product_id);
      if (!product) {
        continue;
      }

      const updateResult = db.prepare(`
        UPDATE products 
        SET available_stock = available_stock + ?, 
            reserved_stock = reserved_stock - ?,
            version = version + 1
        WHERE id = ? AND reserved_stock >= ? AND version = ?
      `).run(item.quantity, item.quantity, item.product_id, item.quantity, product.version);

      if (updateResult.changes === 0) {
        throw new Error(`库存释放失败`);
      }

      db.prepare(`
        INSERT INTO stock_operations (order_id, order_no, product_id, operation_type, quantity, idempotent_key)
        SELECT ?, o.order_no, ?, 'release', ?, ?
        FROM orders o WHERE o.id = ?
      `).run(orderId, item.product_id, item.quantity, idempotentKey, orderId);
    }

    const releaseMarkResult = db.prepare(`
      UPDATE orders 
      SET stock_released = 1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ? AND stock_released = 0 AND stock_confirmed = 0
    `).run(orderId);

    if (releaseMarkResult.changes === 0) {
      const checkOrder = db.prepare('SELECT id, stock_released FROM orders WHERE id = ?').get(orderId);
      if (!checkOrder || checkOrder.stock_released !== 1) {
        throw new Error('库存释放标记更新失败');
      }
    }
  });

  releaseTransaction(orderId);
}

function getStockStats(productId) {
  return db.prepare(`
    SELECT available_stock, reserved_stock, sold_stock, 
           (available_stock + reserved_stock) as total_stock
    FROM products WHERE id = ?
  `).get(productId);
}

module.exports = {
  reserveStockForOrder,
  confirmStockForOrder,
  releaseStockForOrder,
  getStockStats
};
