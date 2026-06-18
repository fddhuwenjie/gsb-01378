const express = require('express');
const crypto = require('crypto');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// 微信支付配置
const WECHAT_MOCK_PAY = process.env.WECHAT_MOCK_PAY === 'true';
const WECHAT_APP_ID = process.env.WECHAT_APP_ID;
const WECHAT_MCH_ID = process.env.WECHAT_MCH_ID;
const WECHAT_API_KEY = process.env.WECHAT_API_KEY;
const WECHAT_PAY_NOTIFY_URL = process.env.WECHAT_PAY_NOTIFY_URL;

// 生成随机字符串
function generateNonceStr(length = 32) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

// 创建支付订单
router.post('/create', authMiddleware, async (req, res) => {
  const { order_id } = req.body;

  if (!order_id) {
    return res.status(400).json({ error: '缺少订单ID' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order_id, req.user.id);
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status !== 'pending') {
    return res.status(400).json({ error: '订单状态不正确' });
  }

  // 开发/演示环境：模拟支付
  if (WECHAT_MOCK_PAY) {
    const mockPayData = {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: generateNonceStr(),
      package: 'prepay_id=mock_prepay_' + Date.now(),
      signType: 'RSA',
      paySign: 'mock_sign_' + generateNonceStr(16),
      mock: true
    };
    return res.json(mockPayData);
  }

  // 生产环境：调用微信支付API
  if (!WECHAT_APP_ID || !WECHAT_MCH_ID || !WECHAT_API_KEY) {
    return res.status(500).json({ error: '微信支付配置缺失' });
  }

  try {
    const axios = require('axios');
    const fs = require('fs');
    
    // 读取私钥
    const privateKeyPath = process.env.WECHAT_PRIVATE_KEY_PATH || './certs/apiclient_key.pem';
    if (!fs.existsSync(privateKeyPath)) {
      return res.status(500).json({ error: '支付证书未配置' });
    }
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

    const timestamp = Math.floor(Date.now() / 1000);
    const nonceStr = generateNonceStr();
    
    // 构建请求参数
    const requestBody = {
      appid: WECHAT_APP_ID,
      mchid: WECHAT_MCH_ID,
      description: '商品订单',
      out_trade_no: order.order_no,
      notify_url: WECHAT_PAY_NOTIFY_URL,
      amount: {
        total: Math.round(order.total_amount * 100), // 转为分
        currency: 'CNY'
      },
      payer: {
        openid: req.user.openid
      }
    };

    // 生成签名
    const url = '/v3/pay/transactions/jsapi';
    const signStr = `POST\n${url}\n${timestamp}\n${nonceStr}\n${JSON.stringify(requestBody)}\n`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signStr);
    const signature = sign.sign(privateKey, 'base64');

    const certSerialNo = process.env.WECHAT_CERT_SERIAL_NO;
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${WECHAT_MCH_ID}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${certSerialNo}",signature="${signature}"`;

    // 调用微信支付API
    const response = await axios.post('https://api.mch.weixin.qq.com' + url, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': authorization
      }
    });

    const prepayId = response.data.prepay_id;

    // 生成小程序调起支付的参数
    const payTimestamp = String(Math.floor(Date.now() / 1000));
    const payNonceStr = generateNonceStr();
    const packageStr = `prepay_id=${prepayId}`;
    
    const paySignStr = `${WECHAT_APP_ID}\n${payTimestamp}\n${payNonceStr}\n${packageStr}\n`;
    const paySign = crypto.createSign('RSA-SHA256');
    paySign.update(paySignStr);
    const paySignature = paySign.sign(privateKey, 'base64');

    res.json({
      timeStamp: payTimestamp,
      nonceStr: payNonceStr,
      package: packageStr,
      signType: 'RSA',
      paySign: paySignature
    });

  } catch (err) {
    console.error('创建支付订单失败:', err.response?.data || err.message);
    res.status(500).json({ error: '创建支付订单失败' });
  }
});

// 模拟支付成功（仅开发环境）
router.post('/mock-success', authMiddleware, (req, res) => {
  if (!WECHAT_MOCK_PAY) {
    return res.status(400).json({ error: '非模拟支付环境' });
  }

  const { order_id } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order_id, req.user.id);
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status !== 'pending') {
    return res.status(400).json({ error: '订单状态不正确' });
  }

  // 更新订单状态为已支付
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('paid', order_id);

  res.json({ message: '支付成功' });
});

// 微信支付回调通知
router.post('/notify', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // 验证签名（生产环境需要实现）
    const body = JSON.parse(req.body.toString());
    
    if (body.event_type === 'TRANSACTION.SUCCESS') {
      const resource = body.resource;
      
      // 解密数据（生产环境需要实现AES-256-GCM解密）
      // const decrypted = decryptResource(resource);
      // const orderNo = decrypted.out_trade_no;
      
      // 这里简化处理，实际需要解密
      const orderNo = resource.out_trade_no;
      
      // 更新订单状态
      const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
      if (order && order.status === 'pending') {
        db.prepare('UPDATE orders SET status = ? WHERE order_no = ?').run('paid', orderNo);
      }
    }

    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('支付回调处理失败:', err);
    res.status(500).json({ code: 'FAIL', message: '处理失败' });
  }
});

// 查询支付状态
router.get('/status/:orderId', authMiddleware, (req, res) => {
  const { orderId } = req.params;
  const order = db.prepare('SELECT id, order_no, status, total_amount FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.user.id);
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  res.json({
    order_id: order.id,
    order_no: order.order_no,
    status: order.status,
    paid: order.status !== 'pending' && order.status !== 'cancelled'
  });
});

module.exports = router;
