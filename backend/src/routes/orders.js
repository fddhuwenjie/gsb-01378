const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const inventoryService = require('../services/inventoryService');

const router = express.Router();

const ORDER_PAY_TIMEOUT_MINUTES = inventoryService.ORDER_PAY_TIMEOUT_MINUTES;

function generateOrderNo() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `ORD${dateStr}${random}`;
}

function calculatePayExpireTime() {
  return new Date(Date.now() + ORDER_PAY_TIMEOUT_MINUTES * 60 * 1000).toISOString();
}

function formatOrderWithExpiry(order) {
  if (!order) return order;
  const now = Date.now();
  const expireTime = order.pay_expire_time ? new Date(order.pay_expire_time).getTime() : null;
  let remainingSeconds = 0;
  let expired = false;
  
  if (order.status === 'pending' && expireTime) {
    remainingSeconds = Math.max(0, Math.floor((expireTime - now) / 1000));
    expired = remainingSeconds === 0;
  }

  return {
    ...order,
    pay_timeout_minutes: ORDER_PAY_TIMEOUT_MINUTES,
    remaining_pay_seconds: remainingSeconds,
    is_expired: expired,
    pay_expire_time_formatted: expireTime ? new Date(expireTime).toLocaleString('zh-CN') : null
  };
}

router.get('/', authMiddleware, (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  let sql = 'SELECT * FROM orders WHERE user_id = ?';
  const params = [req.user.id];

  if (status) {
    if (status === 'cancelled') {
      sql += ' AND (status = ? OR status = ?)';
      params.push('cancelled', 'timeout');
    } else {
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
    return formatOrderWithExpiry({ ...order, items });
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

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  
  res.json(formatOrderWithExpiry({ ...order, items }));
});

router.post('/', authMiddleware, (req, res) => {
  const { items, address, receiver_name, receiver_phone, remark, idempotent_key } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: '订单商品不能为空' });
  }

  const clientIdempotentKey = idempotent_key || uuidv4();

  try {
    const existingOrder = db.prepare('SELECT * FROM orders WHERE idempotent_key = ? AND user_id = ?').get(clientIdempotentKey, req.user.id);
    if (existingOrder) {
      const existingItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(existingOrder.id);
      return res.json({
        message: '订单已存在（幂等返回）',
        order_no: existingOrder.order_no,
        order_id: existingOrder.id,
        is_idempotent: true,
        order: formatOrderWithExpiry({ ...existingOrder, items: existingItems })
      });
    }
  } catch (err) {
    if (!err.message.includes('UNIQUE')) {
      console.error('幂等检查失败:', err);
    }
  }

  let totalAmount = 0;
  const productList = [];

  for (const item of items) {
    const product = db.prepare('SELECT id, name, price, stock, reserved_stock, status FROM products WHERE id = ? AND status = 1').get(item.product_id);
    
    if (!product) {
      return res.status(400).json({ error: `商品ID ${item.product_id} 不存在或已下架` });
    }

    const availableStock = product.stock - product.reserved_stock;
    if (availableStock < item.quantity) {
      return res.status(400).json({ error: `商品「${product.name}」库存不足，可售库存：${availableStock}` });
    }

    totalAmount += product.price * item.quantity;
    productList.push({
      product_id: product.id,
      product_name: product.name,
      product_image: product.image || '',
      price: product.price,
      quantity: item.quantity
    });
  }

  let orderResult;
  let needsRollback = false;
  
  try {
    const payExpireTime = calculatePayExpireTime();
    
    const createOrderTransaction = db.transaction(() => {
      const orderNo = generateOrderNo();
      const insertOrderResult = db.prepare(`
        INSERT INTO orders (order_no, user_id, total_amount, status, address, receiver_name, receiver_phone, remark, idempotent_key, pay_expire_time, stock_locked, stock_processed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
      `).run(orderNo, req.user.id, totalAmount, 'pending', address || '', receiver_name || '', receiver_phone || '', remark || '', clientIdempotentKey, payExpireTime);

      const orderId = insertOrderResult.lastInsertRowid;

      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, product_image, quantity, price)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const pl of productList) {
        insertItem.run(orderId, pl.product_id, pl.product_name, pl.product_image, pl.quantity, pl.price);
      }

      inventoryService.reserveStock(orderId, orderNo, productList);

      return { orderNo, orderId, payExpireTime };
    });

    orderResult = createOrderTransaction();
    needsRollback = false;

    const productIds = items.map(i => i.product_id);
    db.prepare(`DELETE FROM cart WHERE user_id = ? AND product_id IN (${productIds.map(() => '?').join(',')})`).run(req.user.id, ...productIds);

    const createdItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderResult.orderId);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderResult.orderId);

    res.json({
      message: '订单创建成功',
      order_no: orderResult.orderNo,
      order_id: orderResult.orderId,
      pay_timeout_minutes: ORDER_PAY_TIMEOUT_MINUTES,
      pay_expire_time: orderResult.payExpireTime,
      order: formatOrderWithExpiry({ ...order, items: createdItems })
    });

  } catch (err) {
    console.error('订单创建失败:', err);
    
    if (err.message && err.message.includes('UNIQUE constraint failed: orders.idempotent_key')) {
      try {
        const existingOrder = db.prepare('SELECT * FROM orders WHERE idempotent_key = ? AND user_id = ?').get(clientIdempotentKey, req.user.id);
        if (existingOrder) {
          const existingItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(existingOrder.id);
          return res.json({
            message: '订单已存在（幂等返回）',
            order_no: existingOrder.order_no,
            order_id: existingOrder.id,
            is_idempotent: true,
            order: formatOrderWithExpiry({ ...existingOrder, items: existingItems })
          });
        }
      } catch (innerErr) {
        console.error('幂等重试失败:', innerErr);
      }
    }

    res.status(400).json({ error: err.message || '订单创建失败，请重试' });
  }
});

router.put('/:id/cancel', authMiddleware, (req, res) => {
  const { id } = req.params;

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.user.id);
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status !== 'pending') {
    if (order.status === 'timeout') {
      return res.status(400).json({ error: '订单已超时关闭' });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: '订单已取消' });
    }
    if (order.status === 'paid' || order.status === 'shipped' || order.status === 'completed') {
      return res.status(400).json({ error: '订单已支付，无法取消' });
    }
    return res.status(400).json({ error: `订单状态 ${order.status} 不允许取消` });
  }

  try {
    const tx = db.transaction(() => {
      const updateResult = db.prepare(`
        UPDATE orders SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP 
        WHERE id = ? AND status = 'pending'
      `).run(id);
      
      if (updateResult.changes === 0) {
        throw new Error('订单状态已变更，取消失败');
      }
      return true;
    });

    tx();
    inventoryService.releaseStock(order.id, order.order_no, '用户主动取消');

    res.json({ message: '订单已取消，库存已释放' });
  } catch (err) {
    console.error('取消订单失败:', err);
    res.status(400).json({ error: err.message || '取消订单失败，请重试' });
  }
});

router.get('/admin/all', authMiddleware, adminMiddleware, (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  let sql = 'SELECT o.*, u.nickname as user_nickname FROM orders o LEFT JOIN users u ON o.user_id = u.id';
  const params = [];

  if (status) {
    if (status === 'cancelled') {
      sql += ' WHERE o.status = ? OR o.status = ?';
      params.push('cancelled', 'timeout');
    } else {
      sql += ' WHERE o.status = ?';
      params.push(status);
    }
  }

  const countSql = sql.replace('SELECT o.*, u.nickname as user_nickname', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(...params);

  sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const orders = db.prepare(sql).all(...params);

  const ordersWithItems = orders.map(order => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    return formatOrderWithExpiry({ ...order, items });
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

  const currentStatus = order.status;

  if (currentStatus === 'paid' && status !== 'shipped' && status !== 'completed') {
    return res.status(400).json({ error: '已支付订单只能发货或完成' });
  }

  if (currentStatus === 'shipped' && status !== 'completed') {
    return res.status(400).json({ error: '已发货订单只能完成' });
  }

  if ((currentStatus === 'cancelled' || currentStatus === 'timeout' || currentStatus === 'completed') && status !== currentStatus) {
    return res.status(400).json({ error: '订单已终态，无法修改' });
  }

  try {
    const tx = db.transaction(() => {
      if (status === 'cancelled' && currentStatus === 'pending') {
        db.prepare(`UPDATE orders SET status = ?, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, id);
        inventoryService.releaseStock(order.id, order.order_no, '管理员取消订单');
      } else {
        db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
      }
    });

    tx();
    res.json({ message: '状态更新成功' });
  } catch (err) {
    console.error('状态更新失败:', err);
    res.status(400).json({ error: err.message || '状态更新失败' });
  }
});

router.post('/admin/process-expired', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const result = inventoryService.processExpiredOrders();
    res.json({ message: `处理完成，共扫描 ${result.total} 个超时订单，释放 ${result.released} 个订单库存`, ...result });
  } catch (err) {
    console.error('处理超时订单失败:', err);
    res.status(500).json({ error: '处理超时订单失败' });
  }
});

module.exports = router;
