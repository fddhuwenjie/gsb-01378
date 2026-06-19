const express = require('express');
const { db } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const stockService = require('../services/stockService');

const router = express.Router();

// 订单支付有效期（毫秒），默认 15 分钟。可通过环境变量 ORDER_PAY_TTL_MS 覆盖。
const ORDER_PAY_TTL_MS = parseInt(process.env.ORDER_PAY_TTL_MS || (15 * 60 * 1000), 10);

// 生成订单号
function generateOrderNo() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `ORD${dateStr}${random}`;
}

// 计算订单当前剩余支付时间，并附带 expired 标识返回给前端
function decorateOrder(order) {
  if (!order) return order;
  let remainingMs = 0;
  let expired = false;
  if (order.expire_at) {
    const expireMs = new Date(order.expire_at + 'Z').getTime();
    if (!Number.isNaN(expireMs)) {
      remainingMs = Math.max(0, expireMs - Date.now());
      expired = remainingMs === 0 && order.status === 'pending';
    }
  }
  return {
    ...order,
    remaining_ms: order.status === 'pending' ? remainingMs : 0,
    pay_expired: expired,
  };
}

// 获取用户订单列表
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

  // 列表读取时顺手把"看起来已过期但还是 pending"的订单触发被动回收一次。
  // 这层是 reaper 的兜底：即使 reaper 挂掉，用户每次刷新订单列表也能驱动回收。
  for (const o of orders) {
    if (o.status === 'pending') stockService.expireIfNeeded(o.id);
  }
  // 重新读一次，避免回收后状态还展示成 pending
  const refreshed = db.prepare(sql).all(...params);

  const ordersWithItems = refreshed.map(order => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    return decorateOrder({ ...order, items });
  });

  res.json({
    list: ordersWithItems,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / limit)
  });
});

// 获取订单详情
router.get('/:id', authMiddleware, (req, res) => {
  const { id } = req.params;

  // 进入详情时同样做一次被动过期检查
  stockService.expireIfNeeded(parseInt(id, 10));

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

  res.json(decorateOrder({ ...order, items }));
});

// 创建订单
router.post('/', authMiddleware, (req, res) => {
  const { items, address, receiver_name, receiver_phone, remark, idempotency_key } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: '订单商品不能为空' });
  }

  // 幂等：同一用户带相同 idempotency_key 的请求只会落库一次。
  // 用户连续点击/网络重试都会命中这里，直接返回上一次的订单。
  if (idempotency_key) {
    const dup = db.prepare(
      'SELECT id, order_no FROM orders WHERE user_id = ? AND idempotency_key = ?'
    ).get(req.user.id, idempotency_key);
    if (dup) {
      return res.json({ message: '订单已创建', order_no: dup.order_no, order_id: dup.id, idempotent: true });
    }
  }

  // 第一阶段：在内存里聚合并校验 —— 这一阶段不动数据库
  let totalAmount = 0;
  const productList = [];
  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(item.product_id);
    if (!product) {
      return res.status(400).json({ error: `商品ID ${item.product_id} 不存在或已下架` });
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return res.status(400).json({ error: '商品数量不合法' });
    }
    // 这里只做"软校验"用于快速失败；真正的库存判定在 reserveStock 里通过原子 SQL 完成
    if (product.stock < item.quantity) {
      return res.status(400).json({ error: `商品 ${product.name} 库存不足` });
    }
    totalAmount += product.price * item.quantity;
    productList.push({ product, quantity: item.quantity });
  }

  const orderNo = generateOrderNo();
  const expireAt = new Date(Date.now() + ORDER_PAY_TTL_MS);
  // 把 expire_at 写成 SQLite 的 UTC 文本（'YYYY-MM-DD HH:MM:SS'），与 datetime('now') 同口径
  const expireAtSql = expireAt.toISOString().slice(0, 19).replace('T', ' ');

  // 第二阶段：单事务内同时创建订单/订单项 + 预占库存
  // 一旦任意一行库存不够，事务整体回滚；不会出现"订单已建但库存没扣"的中间态
  const createOrderTx = db.transaction(() => {
    const orderResult = db.prepare(`
      INSERT INTO orders (order_no, user_id, total_amount, address, receiver_name, receiver_phone, remark, expire_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderNo,
      req.user.id,
      totalAmount,
      address || '',
      receiver_name || '',
      receiver_phone || '',
      remark || '',
      expireAtSql,
      idempotency_key || null
    );

    const orderId = orderResult.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, product_image, quantity, price)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const { product, quantity } of productList) {
      insertItem.run(orderId, product.id, product.name, product.image, quantity, product.price);
    }

    // 预占库存（带原子 WHERE stock>=? 防超卖；任何一行失败会抛出异常使整个事务回滚）
    const reserveResult = stockService.reserveStock({
      orderId,
      orderNo,
      items: productList.map(p => ({ product_id: p.product.id, quantity: p.quantity })),
    });
    if (!reserveResult.ok) {
      const e = new Error('STOCK_NOT_ENOUGH');
      e.product_id = reserveResult.conflict && reserveResult.conflict.product_id;
      throw e;
    }

    // 清空购物车中已下单的商品
    const productIds = items.map(i => i.product_id);
    if (productIds.length > 0) {
      db.prepare(
        `DELETE FROM cart WHERE user_id = ? AND product_id IN (${productIds.map(() => '?').join(',')})`
      ).run(req.user.id, ...productIds);
    }

    return { orderId };
  });

  try {
    const { orderId } = createOrderTx();
    res.json({
      message: '订单创建成功',
      order_no: orderNo,
      order_id: orderId,
      expire_at: expireAt.toISOString(),
      remaining_ms: ORDER_PAY_TTL_MS,
    });
  } catch (err) {
    if (err.message === 'STOCK_NOT_ENOUGH') {
      // 并发场景下，软校验通过了但 reserveStock 仍然失败 —— 说明刚刚被别人抢走
      const conflict = err.product_id
        ? db.prepare('SELECT name FROM products WHERE id = ?').get(err.product_id)
        : null;
      return res.status(409).json({
        error: conflict ? `商品 ${conflict.name} 库存不足，请重新下单` : '库存不足，请重新下单',
        code: 'STOCK_NOT_ENOUGH',
      });
    }
    if (err.message && err.message.indexOf('UNIQUE constraint failed: orders.idempotency_key') >= 0) {
      // 同一幂等键并发提交，让重试方读取已存在的订单
      const dup = db.prepare(
        'SELECT id, order_no FROM orders WHERE user_id = ? AND idempotency_key = ?'
      ).get(req.user.id, idempotency_key);
      if (dup) return res.json({ message: '订单已创建', order_no: dup.order_no, order_id: dup.id, idempotent: true });
    }
    console.error('订单创建失败:', err);
    res.status(500).json({ error: '订单创建失败，请重试' });
  }
});

// 取消订单（用户主动）
router.put('/:id/cancel', authMiddleware, (req, res) => {
  const { id } = req.params;

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }
  if (order.status !== 'pending') {
    return res.status(400).json({ error: '只能取消待付款订单' });
  }

  try {
    const r = stockService.releaseStock({ orderId: order.id, reason: 'cancel' });
    if (!r.ok && r.alreadyDone) {
      return res.status(400).json({ error: '订单状态已变更，无需取消' });
    }
    res.json({ message: '订单已取消' });
  } catch (err) {
    console.error('取消订单失败:', err);
    res.status(500).json({ error: '取消订单失败，请重试' });
  }
});

// 管理员：获取所有订单
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
    return decorateOrder({ ...order, items });
  });

  res.json({
    list: ordersWithItems,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / limit)
  });
});

// 管理员：更新订单状态（仅允许 paid 之后的合法迁移；不能直接把 pending 改成 paid，这必须走支付链路）
router.put('/admin/:id/status', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['shipped', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: '管理员只能修改为 shipped/completed/cancelled' });
  }

  const order = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  // 管理员手动取消 pending 订单：要走库存回滚
  if (status === 'cancelled' && order.status === 'pending') {
    stockService.releaseStock({ orderId: order.id, reason: 'admin_cancel' });
    return res.json({ message: '订单已取消并释放库存' });
  }
  // 仅允许从合法前态推进到 shipped/completed
  const allowed = {
    shipped: ['paid'],
    completed: ['shipped', 'paid'],
    cancelled: ['paid'], // 已支付订单的"取消"通常意味着退款流程；这里仅打标，库存不动
  };
  if (!allowed[status].includes(order.status)) {
    return res.status(400).json({ error: `不能从 ${order.status} 直接到 ${status}` });
  }

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);

  res.json({ message: '状态更新成功' });
});

// 管理员：库存流水（按商品维度）
router.get('/admin/stock-logs', authMiddleware, adminMiddleware, (req, res) => {
  const { product_id, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let sql = 'SELECT * FROM stock_logs';
  const params = [];
  if (product_id) {
    sql += ' WHERE product_id = ?';
    params.push(parseInt(product_id));
  }
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(...params);

  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const list = db.prepare(sql).all(...params);
  res.json({ list, total, page: parseInt(page), limit: parseInt(limit) });
});

module.exports = router;
