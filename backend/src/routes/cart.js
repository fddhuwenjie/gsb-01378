const express = require('express');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.get('/', authMiddleware, (req, res) => {
  const items = db.prepare(`
    SELECT c.id, c.quantity, c.product_id,
           p.name, p.price, p.original_price, p.image, p.stock, p.reserved_stock, p.status,
           (p.stock - p.reserved_stock) as available_stock
    FROM cart c
    JOIN products p ON c.product_id = p.id
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).all(req.user.id);

  const totalAmount = items.reduce((sum, item) => {
    if (item.status === 1) {
      return sum + item.price * item.quantity;
    }
    return sum;
  }, 0);

  res.json({
    items,
    totalAmount,
    totalCount: items.length
  });
});

router.post('/', authMiddleware, (req, res) => {
  const { product_id, quantity = 1 } = req.body;

  if (!product_id) {
    return res.status(400).json({ error: '商品ID不能为空' });
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(product_id);
  if (!product) {
    return res.status(404).json({ error: '商品不存在或已下架' });
  }

  const availableStock = (product.stock || 0) - (product.reserved_stock || 0);
  if (availableStock < quantity) {
    return res.status(400).json({ error: `库存不足，可售库存：${availableStock}` });
  }

  const existing = db.prepare('SELECT * FROM cart WHERE user_id = ? AND product_id = ?').get(req.user.id, product_id);

  if (existing) {
    const newQuantity = existing.quantity + quantity;
    if (newQuantity > availableStock) {
      return res.status(400).json({ error: `超出可售库存数量，可售：${availableStock}` });
    }
    db.prepare('UPDATE cart SET quantity = ? WHERE id = ?').run(newQuantity, existing.id);
    res.json({ message: '购物车已更新', quantity: newQuantity, available_stock: availableStock });
  } else {
    db.prepare('INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)').run(req.user.id, product_id, quantity);
    res.json({ message: '已添加到购物车', available_stock: availableStock });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { quantity } = req.body;

  if (!quantity || quantity < 1) {
    return res.status(400).json({ error: '数量必须大于0' });
  }

  const cartItem = db.prepare(`
    SELECT c.*, p.stock, p.reserved_stock 
    FROM cart c 
    JOIN products p ON c.product_id = p.id 
    WHERE c.id = ? AND c.user_id = ?
  `).get(id, req.user.id);

  if (!cartItem) {
    return res.status(404).json({ error: '购物车商品不存在' });
  }

  const availableStock = (cartItem.stock || 0) - (cartItem.reserved_stock || 0);
  if (quantity > availableStock) {
    return res.status(400).json({ error: `超出可售库存数量，可售：${availableStock}` });
  }

  db.prepare('UPDATE cart SET quantity = ? WHERE id = ?').run(quantity, id);

  res.json({ message: '更新成功', available_stock: availableStock });
});

router.delete('/:id', authMiddleware, (req, res) => {
  const { id } = req.params;

  const cartItem = db.prepare('SELECT id FROM cart WHERE id = ? AND user_id = ?').get(id, req.user.id);

  if (!cartItem) {
    return res.status(404).json({ error: '购物车商品不存在' });
  }

  db.prepare('DELETE FROM cart WHERE id = ?').run(id);

  res.json({ message: '删除成功' });
});

router.delete('/', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM cart WHERE user_id = ?').run(req.user.id);
  res.json({ message: '购物车已清空' });
});

module.exports = router;
