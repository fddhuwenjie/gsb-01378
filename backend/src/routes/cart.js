const express = require('express');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const stockService = require('../services/stockService');

const router = express.Router();

function calculateAvailableStock(product) {
  return Math.max(0, (product.total_stock || 0) - (product.locked_stock || 0) - (product.sold_stock || 0));
}

router.get('/', authMiddleware, (req, res) => {
  const items = db.prepare(`
    SELECT c.id, c.quantity, c.product_id,
           p.name, p.price, p.original_price, p.image, 
           p.total_stock, p.locked_stock, p.sold_stock, p.status
    FROM cart c
    JOIN products p ON c.product_id = p.id
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).all(req.user.id);

  const enrichedItems = items.map(item => ({
    ...item,
    stock: calculateAvailableStock(item),
    available_stock: calculateAvailableStock(item)
  }));

  const totalAmount = enrichedItems.reduce((sum, item) => {
    if (item.status === 1) {
      return sum + item.price * item.quantity;
    }
    return sum;
  }, 0);

  res.json({
    items: enrichedItems,
    totalAmount,
    totalCount: enrichedItems.length
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

  const availableStock = calculateAvailableStock(product);
  if (availableStock < quantity) {
    return res.status(400).json({ error: `库存不足，仅剩 ${availableStock} 件` });
  }

  const existing = db.prepare('SELECT * FROM cart WHERE user_id = ? AND product_id = ?').get(req.user.id, product_id);

  if (existing) {
    const newQuantity = existing.quantity + quantity;
    if (newQuantity > availableStock) {
      return res.status(400).json({ error: `超出库存数量，最多可购买 ${availableStock} 件` });
    }
    db.prepare('UPDATE cart SET quantity = ? WHERE id = ?').run(newQuantity, existing.id);
    res.json({ message: '购物车已更新', quantity: newQuantity });
  } else {
    db.prepare('INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)').run(req.user.id, product_id, quantity);
    res.json({ message: '已添加到购物车' });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { quantity } = req.body;

  if (!quantity || quantity < 1) {
    return res.status(400).json({ error: '数量必须大于0' });
  }

  const cartItem = db.prepare(`
    SELECT c.*, p.total_stock, p.locked_stock, p.sold_stock 
    FROM cart c JOIN products p ON c.product_id = p.id 
    WHERE c.id = ? AND c.user_id = ?
  `).get(id, req.user.id);

  if (!cartItem) {
    return res.status(404).json({ error: '购物车商品不存在' });
  }

  const availableStock = calculateAvailableStock(cartItem);
  if (quantity > availableStock) {
    return res.status(400).json({ error: `超出库存数量，最多可购买 ${availableStock} 件` });
  }

  db.prepare('UPDATE cart SET quantity = ? WHERE id = ?').run(quantity, id);

  res.json({ message: '更新成功' });
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
