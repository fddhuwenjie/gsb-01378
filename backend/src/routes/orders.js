const express = require('express');
const crypto = require('crypto');
const { db } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { reserveStockForOrder, releaseStockForOrder } = require('../services/stockService');
const { calculateExpireTime, getOrderTimeRemaining, processTimeoutOrders } = require('../services/orderTimeoutService');

const router = express.Router();

function generateOrderNo() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `ORD${dateStr}${random}`;
}

function enrichOrderWithTimeInfo(order) {
  const timeInfo = getOrderTimeRemaining(order);
  return {
    ...order,
    time_remaining: timeInfo
  };
}

router.get('/', authMiddleware, (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  let sql = 'SELECT * FROM orders WHERE user_id = ?';
  const params = [req.user.id];

  if (status) {
    const validStatuses = ['pending', 'paid', 'shipped', 'completed', 'cancelled', 'timeout'];
    if (validStatuses.includes(status)) {
      sql += ' AND status = ?';
      params.push(status);
    }
  }

  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(...params);

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const orders = db.prepare(sql).all(...params);

  const ordersWithItems = orders.map(order => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    return enrichOrderWithTimeInfo({ ...order, items });
  });

  res.json({
    list: ordersWithItems,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / limit)
  });
});

router.get('/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  
  let order;
  if (req.user.role === 'admin') {
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  } else {
    order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.user.id);
  }

  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status === 'pending' && order.expire_at) {
    const timeInfo = getOrderTimeRemaining(order);
    if (timeInfo && timeInfo.expired) {
      try {
        const closeExpiredOrder = db.transaction((orderId) => {
          const o = db.prepare('SELECT id, status, stock_reserved, stock_released FROM orders WHERE id = ?').get(orderId);
          if (o && o.status === 'pending' && o.stock_released === 0) {
            releaseStockForOrder(orderId);
            db.prepare(`
              UPDATE orders 
              SET status = 'timeout', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
              WHERE id = ? AND status = 'pending' AND stock_released = 1
            `).run(orderId);
          }
        });
        closeExpiredOrder(order.id);
        order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      } catch (err) {
        console.error('关闭过期订单失败:', err);
      }
    }
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);

  res.json(enrichOrderWithTimeInfo({ ...order, items }));
});

router.post('/', authMiddleware, (req, res) => {
  const { items, address, receiver_name, receiver_phone, remark, idempotency_key } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: '订单商品不能为空' });
  }

  const clientIdempotencyKey = idempotency_key || crypto.randomBytes(16).toString('hex');

  if (clientIdempotencyKey) {
    const existingOrder = db.prepare(`
      SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?
    `).get(req.user.id, clientIdempotencyKey);
    
    if (existingOrder) {
      const existingItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(existingOrder.id);
      return res.json({
        message: '订单创建成功',
        order_no: existingOrder.order_no,
        order_id: existingOrder.id,
        expire_at: existingOrder.expire_at,
        duplicated: true
      });
    }
  }

  let totalAmount = 0;
  const productList = [];

  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(item.product_id);
    
    if (!product) {
      return res.status(400).json({ error: `商品ID ${item.product_id} 不存在或已下架` });
    }

    if (product.available_stock < item.quantity) {
      return res.status(400).json({ error: `商品「${product.name}」库存不足，仅剩 ${product.available_stock} 件` });
    }

    totalAmount += product.price * item.quantity;
    productList.push({ product, quantity: item.quantity });
  }

  const expireAt = calculateExpireTime();

  const createOrderTransaction = db.transaction(() => {
    const orderNo = generateOrderNo();
    const orderResult = db.prepare(`
      INSERT INTO orders (order_no, user_id, idempotency_key, total_amount, status, address, receiver_name, receiver_phone, remark, expire_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(orderNo, req.user.id, clientIdempotencyKey, totalAmount, address || '', receiver_name || '', receiver_phone || '', remark || '', expireAt);

    const orderId = orderResult.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, product_image, quantity, price)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const { product, quantity } of productList) {
      insertItem.run(orderId, product.id, product.name, product.image, quantity, product.price);
    }

    reserveStockForOrder(orderId, items);

    const productIds = items.map(i => i.product_id);
    if (productIds.length > 0) {
      const placeholders = productIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM cart WHERE user_id = ? AND product_id IN (${placeholders})`).run(req.user.id, ...productIds);
    }

    return { orderNo, orderId, expireAt };
  });

  try {
    const { orderNo, orderId, expireAt } = createOrderTransaction();
    res.json({ 
      message: '订单创建成功', 
      order_no: orderNo, 
      order_id: orderId,
      expire_at: expireAt,
      idempotency_key: clientIdempotencyKey
    });
  } catch (err) {
    console.error('订单创建失败:', err);
    if (err.message && (err.message.includes('UNIQUE constraint failed: orders.user_id, orders.idempotency_key') || err.message.includes('UNIQUE constraint failed'))) {
      const existingOrder = db.prepare(`
        SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?
      `).get(req.user.id, clientIdempotencyKey);
      if (existingOrder) {
        return res.json({
          message: '订单创建成功',
          order_no: existingOrder.order_no,
          order_id: existingOrder.id,
          expire_at: existingOrder.expire_at,
          duplicated: true
        });
      }
    }
    if (err.message.includes('并发冲突') || err.message.includes('库存不足')) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: '订单创建失败，请重试' });
  }
});

router.put('/:id/cancel', authMiddleware, (req, res) => {
  const { id } = req.params;

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.user.id);
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status === 'cancelled' || order.status === 'timeout') {
    return res.json({ message: '订单已取消' });
  }

  if (order.status !== 'pending') {
    return res.status(400).json({ error: '只能取消待付款订单' });
  }

  const cancelOrderTransaction = db.transaction(() => {
    releaseStockForOrder(order.id);

    const updateResult = db.prepare(`
      UPDATE orders 
      SET status = 'cancelled', 
          cancelled_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP 
      WHERE id = ? AND status = 'pending' AND stock_released = 1
    `).run(id);

    if (updateResult.changes === 0) {
      throw new Error('订单状态更新失败，可能已被处理');
    }
  });

  try {
    cancelOrderTransaction();
    res.json({ message: '订单已取消' });
  } catch (err) {
    console.error('取消订单失败:', err);
    res.status(500).json({ error: '取消订单失败，请重试' });
  }
});

router.get('/admin/all', authMiddleware, adminMiddleware, (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  let sql = 'SELECT o.*, u.nickname as user_nickname FROM orders o LEFT JOIN users u ON o.user_id = u.id';
  const params = [];

  if (status) {
    sql += ' WHERE o.status = ?';
    params.push(status);
  }

  const countSql = sql.replace('SELECT o.*, u.nickname as user_nickname', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(...params);

  sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const orders = db.prepare(sql).all(...params);

  const ordersWithItems = orders.map(order => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    return enrichOrderWithTimeInfo({ ...order, items });
  });

  res.json({
    list: ordersWithItems,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / limit)
  });
});

router.put('/admin/:id/status', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['pending', 'paid', 'shipped', 'completed', 'cancelled', 'timeout'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: '无效的订单状态' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  const updateTransaction = db.transaction(() => {
    if (status === 'cancelled' && order.status === 'pending' && order.stock_released === 0) {
      releaseStockForOrder(id);
      const updateResult = db.prepare(`
        UPDATE orders 
        SET status = 'cancelled', 
            cancelled_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP 
        WHERE id = ? AND stock_released = 1
      `).run(id);
      if (updateResult.changes === 0) {
        throw new Error('状态更新失败');
      }
      return;
    }

    db.prepare(`
      UPDATE orders 
      SET status = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(status, id);
  });

  try {
    updateTransaction();
    res.json({ message: '状态更新成功' });
  } catch (err) {
    console.error('更新订单状态失败:', err);
    res.status(500).json({ error: '更新失败' });
  }
});

router.post('/admin/process-timeout', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const count = processTimeoutOrders();
    res.json({ message: `处理了 ${count} 个超时订单`, count });
  } catch (err) {
    console.error('处理超时订单失败:', err);
    res.status(500).json({ error: '处理失败' });
  }
});

module.exports = router;
