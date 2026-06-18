const express = require('express');
const { db } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// 获取商品列表（公开）
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

  // 获取总数
  const countSql = sql.replace('SELECT p.*, c.name as category_name', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(...params);

  sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const products = db.prepare(sql).all(...params);

  res.json({
    list: products,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / limit)
  });
});

// 获取商品详情（公开）
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

  res.json(product);
});

// 创建商品（管理员）
router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  const { name, description, price, original_price, stock, category_id, image, images, status } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: '商品名称和价格不能为空' });
  }

  const result = db.prepare(`
    INSERT INTO products (name, description, price, original_price, stock, category_id, image, images, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, description || '', price, original_price || price, stock || 0, category_id || null, image || '', JSON.stringify(images || []), status ?? 1);

  res.json({ message: '创建成功', id: result.lastInsertRowid });
});

// 更新商品（管理员）
router.put('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { name, description, price, original_price, stock, category_id, image, images, status } = req.body;

  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(id);
  if (!product) {
    return res.status(404).json({ error: '商品不存在' });
  }

  db.prepare(`
    UPDATE products SET 
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      price = COALESCE(?, price),
      original_price = COALESCE(?, original_price),
      stock = COALESCE(?, stock),
      category_id = COALESCE(?, category_id),
      image = COALESCE(?, image),
      images = COALESCE(?, images),
      status = COALESCE(?, status)
    WHERE id = ?
  `).run(name, description, price, original_price, stock, category_id, image, images ? JSON.stringify(images) : null, status, id);

  res.json({ message: '更新成功' });
});

// 删除商品（管理员）
router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params;

  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(id);
  if (!product) {
    return res.status(404).json({ error: '商品不存在' });
  }

  db.prepare('DELETE FROM products WHERE id = ?').run(id);

  res.json({ message: '删除成功' });
});

// 获取所有商品（管理员，包括下架）
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

  res.json({
    list: products,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / limit)
  });
});

module.exports = router;
