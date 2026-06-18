const express = require('express');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const { db } = require('../database');
const { generateToken, authMiddleware } = require('../middleware/auth');

const router = express.Router();

// 微信登录配置
const WECHAT_MOCK_LOGIN = process.env.WECHAT_MOCK_LOGIN === 'true';
const WECHAT_APP_ID = process.env.WECHAT_APP_ID;
const WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET;

// 管理员登录
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const isValid = bcrypt.compareSync(password, user.password);
  if (!isValid) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = generateToken(user);

  res.json({
    message: '登录成功',
    token,
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      role: user.role
    }
  });
});

// 小程序用户登录
router.post('/mp-login', async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: '缺少登录凭证code' });
  }

  let openid;
  let isMock = false;

  if (WECHAT_MOCK_LOGIN) {
    // 开发/演示环境：模拟登录
    openid = 'mock_openid_' + Date.now();
    isMock = true;
  } else {
    // 生产环境：调用微信API获取openid
    if (!WECHAT_APP_ID || !WECHAT_APP_SECRET) {
      return res.status(500).json({ error: '微信配置缺失，请检查环境变量' });
    }

    try {
      const wxUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_APP_ID}&secret=${WECHAT_APP_SECRET}&js_code=${code}&grant_type=authorization_code`;
      const response = await axios.get(wxUrl);
      const data = response.data;

      if (data.errcode) {
        return res.status(400).json({ error: `微信登录失败: ${data.errmsg}` });
      }

      openid = data.openid;
    } catch (err) {
      console.error('微信API调用失败:', err);
      return res.status(500).json({ error: '微信登录服务异常' });
    }
  }

  let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);

  if (!user) {
    // 创建新用户
    const result = db.prepare('INSERT INTO users (openid, nickname) VALUES (?, ?)').run(openid, '微信用户');
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  }

  const token = generateToken(user);

  res.json({
    message: isMock ? '模拟登录成功（开发环境）' : '登录成功',
    token,
    mock: isMock,
    user: {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar
    }
  });
});

// 获取当前用户信息
router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, nickname, avatar, phone, role FROM users WHERE id = ?').get(req.user.id);
  
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  res.json(user);
});

// 更新用户信息
router.put('/me', authMiddleware, (req, res) => {
  const { nickname, avatar, phone } = req.body;
  
  db.prepare('UPDATE users SET nickname = COALESCE(?, nickname), avatar = COALESCE(?, avatar), phone = COALESCE(?, phone) WHERE id = ?')
    .run(nickname, avatar, phone, req.user.id);

  res.json({ message: '更新成功' });
});

module.exports = router;
