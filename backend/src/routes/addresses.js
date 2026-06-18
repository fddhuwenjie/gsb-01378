const express = require('express');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// 获取用户地址列表
router.get('/', authMiddleware, (req, res) => {
  const addresses = db.prepare(
    'SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC'
  ).all(req.user.id);
  res.json(addresses);
});

// 添加地址
router.post('/', authMiddleware, (req, res) => {
  const { name, phone, region, detail, is_default } = req.body;

  if (!name || !phone || !region || !detail) {
    return res.status(400).json({ error: '请填写完整地址信息' });
  }

  // 如果设为默认，先取消其他默认
  if (is_default) {
    db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(req.user.id);
  }

  const result = db.prepare(
    'INSERT INTO addresses (user_id, name, phone, region, detail, is_default) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, name, phone, region, detail, is_default ? 1 : 0);

  res.json({ message: '添加成功', id: result.lastInsertRowid });
});

// 更新地址
router.put('/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { name, phone, region, detail, is_default } = req.body;

  const address = db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!address) {
    return res.status(404).json({ error: '地址不存在' });
  }

  // 如果设为默认，先取消其他默认
  if (is_default) {
    db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(req.user.id);
  }

  db.prepare(
    'UPDATE addresses SET name = ?, phone = ?, region = ?, detail = ?, is_default = ? WHERE id = ?'
  ).run(name, phone, region, detail, is_default ? 1 : 0, id);

  res.json({ message: '更新成功' });
});

// 删除地址
router.delete('/:id', authMiddleware, (req, res) => {
  const { id } = req.params;

  const address = db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!address) {
    return res.status(404).json({ error: '地址不存在' });
  }

  db.prepare('DELETE FROM addresses WHERE id = ?').run(id);
  res.json({ message: '删除成功' });
});

// 设为默认地址
router.put('/:id/default', authMiddleware, (req, res) => {
  const { id } = req.params;

  const address = db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!address) {
    return res.status(404).json({ error: '地址不存在' });
  }

  db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(req.user.id);
  db.prepare('UPDATE addresses SET is_default = 1 WHERE id = ?').run(id);

  res.json({ message: '设置成功' });
});

module.exports = router;
