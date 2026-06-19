const express = require('express');
const { db } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

function formatProductWithStock(product) {
  if (!product) return product;
  const total_stock = product.stock || 0;
  const reserved_stock = product.reserved_stock || 0;
  const sold_stock = product.sales || 0;
  return {
    ...product,
    total_stock,
    reserved_stock,
    sold_stock,
    available_stock: total_stock - reserved_stock,
    stock: total_stock - reserved_stock
  };
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
  const formattedProducts = products.map(formatProductWithStock);

  res.json({
    list: formattedProducts,
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

  res.json(formatProductWithStock(product));
});

router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  const { name, description, price, original_price, stock, category_id, image, images, status } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: '商品名称和价格不能为空' });
  }

  const result = db.prepare(`
    INSERT INTO products (name, description, price, original_price, stock, reserved_stock, sales, category_id, image, images, status)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
  `).run(name, description || '', price, original_price || price, stock || 0, category_id || null, image || '', JSON.stringify(images || []), status ?? 1);

  res.json({ message: '创建成功', id: result.lastInsertRowid });
});

router.put('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { name, description, price, original_price, stock, category_id, image, images, status } = req.body;

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
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

  const formattedProducts = products.map(formatProductWithStock);

  res.json({
    list: formattedProducts,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    totalPages: Math.ceil(total / limit)
  });
});

router.get('/admin/stock-summary', authMiddleware, adminMiddleware, (req, res) => {
  const summary = db.prepare(`
    SELECT 
      COUNT(*) as total_products,
      SUM(stock) as total_stock,
      SUM(reserved_stock) as total_reserved,
      SUM(sales) as total_sold,
      SUM(stock - reserved_stock) as total_available
    FROM products
  `).get();

  const recentLogs = db.prepare(`
    SELECT sl.*, o.order_no 
    FROM stock_logs sl
    LEFT JOIN orders o ON sl.order_id = o.id
    ORDER BY sl.created_at DESC
    LIMIT 50
  `).all();

  const typeMap = {
    reserve: { text: '预占', color: 'orange' },
    confirm: { text: '确认扣减', color: 'green' },
    release: { text: '释放', color: 'blue' },
    admin_adjust: { text: '管理员调整', color: 'purple' }
  };

  const logsWithType = recentLogs.map(log => ({
    ...log,
    type_info: typeMap[log.type] || { text: log.type, color: 'default' }
  }));

  res.json({
    summary: {
      total_products: summary.total_products || 0,
      total_stock: summary.total_stock || 0,
      total_reserved: summary.total_reserved || 0,
      total_sold: summary.total_sold || 0,
      total_available: summary.total_available || 0
    },
    recent_logs: logsWithType
  });
});

module.exports = router;
