const express = require('express');
const { db } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const stockService = require('../services/stockService');

const router = express.Router();

router.get('/', (req, res) => {
  const { category_id, keyword, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  let sql = 'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.status = 1';
  const params = [];

  if (category_id) {
    sql += ' AND p.category_id = ?';
    params.push(category_id);
  }

  if (keyword) {
    sql += ' AND (p.name LIKE ? OR p.description LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const countSql = sql.replace('SELECT p.*, c.name as category_name', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(...params);

  sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const products = db.prepare(sql).all(...params);
  const enrichedProducts = products.map(p => stockService.enrichProductWithStock(p));

  res.json({
    list: enrichedProducts,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / limit)
  });
});

router.get('/:id', (req, res) => {
  const { id } = req.params;
  const product = db.prepare(`
    SELECT p.*, c.name as category_name 
    FROM products p 
    LEFT JOIN categories c ON p.category_id = c.id 
    WHERE p.id = ?
  `).get(id);

  if (!product) {
    return res.status(404).json({ error: '商品不存在' });
  }

  res.json(stockService.enrichProductWithStock(product));
});

router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  const { name, description, price, original_price, total_stock, category_id, image, images, status } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: '商品名称和价格不能为空' });
  }

  const result = db.prepare(`
    INSERT INTO products (name, description, price, original_price, total_stock, locked_stock, sold_stock, category_id, image, images, status)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
  `).run(name, description || '', price, original_price || price, total_stock || 0, category_id || null, image || '', JSON.stringify(images || []), status ?? 1);

  res.json({ message: '创建成功', id: result.lastInsertRowid });
});

router.put('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { name, description, price, original_price, total_stock, category_id, image, images, status } = req.body;

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) {
    return res.status(404).json({ error: '商品不存在' });
  }

  if (total_stock !== undefined && total_stock !== null) {
    const minimumStock = product.locked_stock + product.sold_stock;
    if (total_stock < minimumStock) {
      return res.status(400).json({ 
        error: `总库存不能小于预占库存+已售库存（${minimumStock}）` 
      });
    }
  }

  db.prepare(`
    UPDATE products SET 
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      price = COALESCE(?, price),
      original_price = COALESCE(?, original_price),
      total_stock = COALESCE(?, total_stock),
      category_id = COALESCE(?, category_id),
      image = COALESCE(?, image),
      images = COALESCE(?, images),
      status = COALESCE(?, status),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name, description, price, original_price, total_stock, 
    category_id, image, images ? JSON.stringify(images) : null, status, id
  );

  res.json({ message: '更新成功' });
});

router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params;

  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(id);
  if (!product) {
    return res.status(404).json({ error: '商品不存在' });
  }

  db.prepare('DELETE FROM products WHERE id = ?').run(id);

  res.json({ message: '删除成功' });
});

router.get('/admin/all', authMiddleware, adminMiddleware, (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  const { total } = db.prepare('SELECT COUNT(*) as total FROM products').get();
  const products = db.prepare(`
    SELECT p.*, c.name as category_name 
    FROM products p 
    LEFT JOIN categories c ON p.category_id = c.id 
    ORDER BY p.created_at DESC 
    LIMIT ? OFFSET ?
  `).all(parseInt(limit), parseInt(offset));

  const enrichedProducts = products.map(p => stockService.enrichProductWithStock(p));

  res.json({
    list: enrichedProducts,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / limit)
  });
});

router.get('/admin/:id/stock-logs', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const logs = stockService.getStockLogs(parseInt(id), parseInt(page), parseInt(limit));
  res.json(logs);
});

router.get('/admin/stock-logs/all', authMiddleware, adminMiddleware, (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const logs = stockService.getStockLogs(null, parseInt(page), parseInt(limit));
  res.json(logs);
});

module.exports = router;
