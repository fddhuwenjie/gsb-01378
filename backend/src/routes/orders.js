const express = require('express');
const { db } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const stockService = require('../services/stockService');

const router = express.Router();

function enrichOrderWithExpireInfo(order) {
  if (!order) return order;
  const now = new Date();
  const expireTime = order.pay_expire_time ? new Date(order.pay_expire_time) : null;
  const remainingMs = expireTime ? Math.max(0, expireTime.getTime() - now.getTime()) : 0;
  const remainingSeconds = Math.floor(remainingMs / 1000);
  
  return {
    ...order,
    pay_expire_remaining: remainingSeconds,
    pay_expired: order.status === 'pending' && remainingMs <= 0 && expireTime !== null
  };
}

router.get('/', authMiddleware, (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  let sql = 'SELECT * FROM orders WHERE user_id = ?';
  const params = [req.user.id];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(...params);

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const orders = db.prepare(sql).all(...params);

  const ordersWithItems = orders.map(order => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    return enrichOrderWithExpireInfo({ ...order, items });
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

  res.json(enrichOrderWithExpireInfo({ ...order, items }));
});

router.post('/', authMiddleware, (req, res) => {
  const { items, address, receiver_name, receiver_phone, remark, idempotency_key } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: '订单商品不能为空' });
  }

  try {
    const result = stockService.createOrderWithStockLock({
      userId: req.user.id,
      items,
      address,
      receiverName: receiver_name,
      receiverPhone: receiver_phone,
      remark,
      idempotencyKey: idempotency_key
    });

    res.json({
      message: result.duplicated ? '订单已存在（幂等返回）' : '订单创建成功',
      order_no: result.orderNo,
      order_id: result.orderId,
      pay_expire_time: result.payExpireTime,
      timeout_minutes: result.timeoutMinutes,
      duplicated: result.duplicated
    });
  } catch (err) {
    console.error('订单创建失败:', err);
    res.status(400).json({ error: err.message || '订单创建失败，请重试' });
  }
});

router.put('/:id/cancel', authMiddleware, (req, res) => {
  const { id } = req.params;

  try {
    stockService.cancelOrder(id, req.user.id);
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
    return enrichOrderWithExpireInfo({ ...order, items });
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

  const order = db.prepare('SELECT id, order_no, status FROM orders WHERE id = ?').get(id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  try {
    if (order.status === 'pending' && (status === 'cancelled' || status === 'timeout')) {
      stockService.releaseOrderStock(id, order.order_no, status === 'timeout' ? 'timeout' : 'admin_cancel');
      return res.json({ message: '状态更新成功，库存已释放' });
    }

    if (order.status === 'pending' && (status === 'paid' || status === 'shipped' || status === 'completed')) {
      stockService.confirmOrderPaid(order.order_no);
      if (status !== 'paid') {
        db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
      }
      return res.json({ message: '状态更新成功' });
    }

    if (order.status !== status) {
      db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
    }

    res.json({ message: '状态更新成功' });
  } catch (err) {
    console.error('更新订单状态失败:', err);
    return res.status(400).json({ error: err.message || '状态更新失败' });
  }
});

module.exports = router;
