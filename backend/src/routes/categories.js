const express = require('express');
const { db } = require('../database');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// 获取所有分类（公开）
router.get('/', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all();
  res.json(categories);
});

// 获取分类详情
router.get('/:id', (req, res) => {
  const { id } = req.params;
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);

  if (!category) {
    return res.status(404).json({ error: '分类不存在' });
  }

  res.json(category);
});

// 创建分类（管理员）
router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  const { name, icon, sort_order } = req.body;

  if (!name) {
    return res.status(400).json({ error: '分类名称不能为空' });
  }

  const result = db.prepare('INSERT INTO categories (name, icon, sort_order) VALUES (?, ?, ?)').run(name, icon || '', sort_order || 0);

  res.json({ message: '创建成功', id: result.lastInsertRowid });
});

// 更新分类（管理员）
router.put('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params;
  const { name, icon, sort_order } = req.body;

  const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
  if (!category) {
    return res.status(404).json({ error: '分类不存在' });
  }

  db.prepare(`
    UPDATE categories SET 
      name = COALESCE(?, name),
      icon = COALESCE(?, icon),
      sort_order = COALESCE(?, sort_order)
    WHERE id = ?
  `).run(name, icon, sort_order, id);

  res.json({ message: '更新成功' });
});

// 删除分类（管理员）
router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { id } = req.params;

  const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
  if (!category) {
    return res.status(404).json({ error: '分类不存在' });
  }

  // 检查是否有商品关联
  const productCount = db.prepare('SELECT COUNT(*) as count FROM products WHERE category_id = ?').get(id);
  if (productCount.count > 0) {
    return res.status(400).json({ error: '该分类下有商品，无法删除' });
  }

  db.prepare('DELETE FROM categories WHERE id = ?').run(id);

  res.json({ message: '删除成功' });
});

module.exports = router;
