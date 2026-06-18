const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// 生成订单号
function generateOrderNo() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `ORD${dateStr}${random}`;
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

  // 获取订单项
  const ordersWithItems = orders.map(order => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    return { ...order, items };
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

  res.json({ ...order, items });
});

// 创建订单
router.post('/', authMiddleware, (req, res) => {
  const { items, address, receiver_name, receiver_phone, remark } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: '订单商品不能为空' });
  }

  // 计算总金额并验证库存
  let totalAmount = 0;
  const productList = [];

  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(item.product_id);
    
    if (!product) {
      return res.status(400).json({ error: `商品ID ${item.product_id} 不存在或已下架` });
    }

    if (product.stock < item.quantity) {
      return res.status(400).json({ error: `商品 ${product.name} 库存不足` });
    }

    totalAmount += product.price * item.quantity;
    productList.push({ product, quantity: item.quantity });
  }

  // 使用事务确保数据一致性
  const createOrderTransaction = db.transaction(() => {
    // 创建订单
    const orderNo = generateOrderNo();
    const orderResult = db.prepare(`
      INSERT INTO orders (order_no, user_id, total_amount, address, receiver_name, receiver_phone, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(orderNo, req.user.id, totalAmount, address || '', receiver_name || '', receiver_phone || '', remark || '');

    const orderId = orderResult.lastInsertRowid;

    // 创建订单项并更新库存
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, product_image, quantity, price)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const updateStock = db.prepare('UPDATE products SET stock = stock - ?, sales = sales + ? WHERE id = ?');

    for (const { product, quantity } of productList) {
      insertItem.run(orderId, product.id, product.name, product.image, quantity, product.price);
      updateStock.run(quantity, quantity, product.id);
    }

    // 清空购物车中的商品
    const productIds = items.map(i => i.product_id);
    db.prepare(`DELETE FROM cart WHERE user_id = ? AND product_id IN (${productIds.join(',')})`).run(req.user.id);

    return { orderNo, orderId };
  });

  try {
    const { orderNo, orderId } = createOrderTransaction();
    res.json({ message: '订单创建成功', order_no: orderNo, order_id: orderId });
  } catch (err) {
    console.error('订单创建失败:', err);
    res.status(500).json({ error: '订单创建失败，请重试' });
  }
});

// 取消订单
router.put('/:id/cancel', authMiddleware, (req, res) => {
  const { id } = req.params;

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.user.id);
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status !== 'pending') {
    return res.status(400).json({ error: '只能取消待付款订单' });
  }

  // 使用事务确保数据一致性
  const cancelOrderTransaction = db.transaction(() => {
    // 恢复库存
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    const restoreStock = db.prepare('UPDATE products SET stock = stock + ?, sales = sales - ? WHERE id = ?');

    for (const item of items) {
      restoreStock.run(item.quantity, item.quantity, item.product_id);
    }

    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('cancelled', id);
  });

  try {
    cancelOrderTransaction();
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
    return { ...order, items };
  });

  res.json({
    list: ordersWithItems,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / limit)
  });
});

// 管理员：更新订单状态
router.put('/admin/:id/status', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['pending', 'paid', 'shipped', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: '无效的订单状态' });
  }

  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);

  res.json({ message: '状态更新成功' });
});

module.exports = router;
