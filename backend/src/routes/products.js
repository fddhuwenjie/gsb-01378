const express = require('express');
const { db } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

function mapProductStock(product, isAdmin = false) {
  const mapped = { ...product };
  mapped.stock = product.available_stock;
  mapped.sales = product.sold_stock;
  if (isAdmin) {
    mapped.available_stock = product.available_stock;
    mapped.reserved_stock = product.reserved_stock;
    mapped.sold_stock = product.sold_stock;
    mapped.total_stock = product.available_stock + product.reserved_stock;
  } else {
    delete mapped.available_stock;
    delete mapped.reserved_stock;
    delete mapped.sold_stock;
  }
  delete mapped.version;
  return mapped;
}

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
  const mappedProducts = products.map(p => mapProductStock(p, false));

  res.json({
    list: mappedProducts,
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

  res.json(mapProductStock(product, false));
});

router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  const { name, description, price, original_price, stock, category_id, image, images, status } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: '商品名称和价格不能为空' });
  }

  const result = db.prepare(`
    INSERT INTO products (name, description, price, original_price, available_stock, category_id, image, images, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, description || '', price, original_price || price, stock || 0, category_id || null, image || '', JSON.stringify(images || []), status ?? 1);

  res.json({ message: '创建成功', id: result.lastInsertRowid });
});

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
      available_stock = COALESCE(?, available_stock),
      category_id = COALESCE(?, category_id),
      image = COALESCE(?, image),
      images = COALESCE(?, images),
      status = COALESCE(?, status)
    WHERE id = ?
  `).run(
    name, 
    description, 
    price, 
    original_price, 
    stock !== undefined ? stock : null, 
    category_id, 
    image, 
    images ? JSON.stringify(images) : null, 
    status, 
    id
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

  const mappedProducts = products.map(p => mapProductStock(p, true));

  res.json({
    list: mappedProducts,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / limit)
  });
});

router.get('/admin/stats/summary', authMiddleware, adminMiddleware, (req, res) => {
  const stats = db.prepare(`
    SELECT 
      SUM(available_stock) as total_available,
      SUM(reserved_stock) as total_reserved,
      SUM(sold_stock) as total_sold,
      COUNT(*) as product_count
    FROM products
  `).get();

  res.json({
    total_available: stats.total_available || 0,
    total_reserved: stats.total_reserved || 0,
    total_sold: stats.total_sold || 0,
    product_count: stats.product_count || 0
  });
});

module.exports = router;
