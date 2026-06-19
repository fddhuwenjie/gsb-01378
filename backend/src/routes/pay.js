const express = require('express');
const crypto = require('crypto');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const stockService = require('../services/stockService');

const router = express.Router();

// 微信支付配置
const WECHAT_MOCK_PAY = process.env.WECHAT_MOCK_PAY === 'true';
const WECHAT_APP_ID = process.env.WECHAT_APP_ID;
const WECHAT_MCH_ID = process.env.WECHAT_MCH_ID;
const WECHAT_API_KEY = process.env.WECHAT_API_KEY;
const WECHAT_PAY_NOTIFY_URL = process.env.WECHAT_PAY_NOTIFY_URL;

function generateNonceStr(length = 32) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

// 创建支付订单
router.post('/create', authMiddleware, async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) {
    return res.status(400).json({ error: '缺少订单ID' });
  }

  // 进入支付前先做一次被动过期检查：
  // 如果订单已经过期，就不应该再让用户调起支付（否则会出现"刚支付完发现订单已 closed"）。
  stockService.expireIfNeeded(parseInt(order_id, 10));

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order_id, req.user.id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }
  if (order.status !== 'pending') {
    return res.status(400).json({ error: '订单状态不正确，可能已支付或已关闭', status: order.status });
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

    const privateKeyPath = process.env.WECHAT_PRIVATE_KEY_PATH || './certs/apiclient_key.pem';
    if (!fs.existsSync(privateKeyPath)) {
      return res.status(500).json({ error: '支付证书未配置' });
    }
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

    const timestamp = Math.floor(Date.now() / 1000);
    const nonceStr = generateNonceStr();

    const requestBody = {
      appid: WECHAT_APP_ID,
      mchid: WECHAT_MCH_ID,
      description: '商品订单',
      out_trade_no: order.order_no,
      notify_url: WECHAT_PAY_NOTIFY_URL,
      amount: {
        total: Math.round(order.total_amount * 100),
        currency: 'CNY'
      },
      payer: {
        openid: req.user.openid
      }
    };

    const url = '/v3/pay/transactions/jsapi';
    const signStr = `POST\n${url}\n${timestamp}\n${nonceStr}\n${JSON.stringify(requestBody)}\n`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signStr);
    const signature = sign.sign(privateKey, 'base64');

    const certSerialNo = process.env.WECHAT_CERT_SERIAL_NO;
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${WECHAT_MCH_ID}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${certSerialNo}",signature="${signature}"`;

    const response = await axios.post('https://api.mch.weixin.qq.com' + url, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': authorization
      }
    });

    const prepayId = response.data.prepay_id;

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
// 走 stockService.commitStock：原子推进 pending->paid 且把 reserved 转 sold；
// 如果订单已经被 reaper 关闭，就返回明确错误，让前端提示用户重新下单。
router.post('/mock-success', authMiddleware, (req, res) => {
  if (!WECHAT_MOCK_PAY) {
    return res.status(400).json({ error: '非模拟支付环境' });
  }

  const { order_id } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order_id, req.user.id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  // 如果在用户支付的瞬间订单已经过期，先尝试把它关掉，再判断
  stockService.expireIfNeeded(order.id);
  const fresh = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(order.id);

  if (fresh.status === 'paid') {
    return res.json({ message: '订单已支付' });
  }
  if (fresh.status === 'closed' || fresh.status === 'cancelled') {
    return res.status(409).json({ error: '订单已关闭，无法支付', code: 'ORDER_CLOSED' });
  }

  try {
    const r = stockService.commitStock({ orderId: order.id });
    if (r.expired) {
      return res.status(409).json({ error: '订单已过期', code: 'ORDER_EXPIRED' });
    }
    if (!r.ok && r.alreadyDone) {
      return res.json({ message: '订单已支付' });
    }
    res.json({ message: '支付成功' });
  } catch (err) {
    console.error('提交支付失败:', err);
    res.status(500).json({ error: '支付确认失败，请联系客服' });
  }
});

// 微信支付回调通知
router.post('/notify', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const body = JSON.parse(req.body.toString());

    if (body.event_type === 'TRANSACTION.SUCCESS') {
      const resource = body.resource;
      // 这里简化处理，生产需要 AES-256-GCM 解密
      const orderNo = resource.out_trade_no;

      const order = db.prepare('SELECT id, status FROM orders WHERE order_no = ?').get(orderNo);
      if (order) {
        // 微信支付的回调可能重复推送（最少投递一次），commitStock 内部已做幂等。
        // 即使此处被 reaper 抢先，commitStock 会安全地返回 expired，由对账流程进行退款。
        try {
          stockService.commitStock({ orderId: order.id });
        } catch (e) {
          console.error('支付回调 commitStock 失败:', e.message);
        }
      }
    }

    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('支付回调处理失败:', err);
    res.status(500).json({ code: 'FAIL', message: '处理失败' });
  }
});

// 查询支付状态
// 关键：每次查询都先做一次被动过期检查，避免前端轮询时仍然显示"待支付"
router.get('/status/:orderId', authMiddleware, (req, res) => {
  const { orderId } = req.params;
  stockService.expireIfNeeded(parseInt(orderId, 10));

  const order = db.prepare(
    'SELECT id, order_no, status, total_amount, expire_at FROM orders WHERE id = ? AND user_id = ?'
  ).get(orderId, req.user.id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  const remainingMs = order.expire_at
    ? Math.max(0, new Date(order.expire_at + 'Z').getTime() - Date.now())
    : 0;

  res.json({
    order_id: order.id,
    order_no: order.order_no,
    status: order.status,
    paid: order.status === 'paid' || order.status === 'shipped' || order.status === 'completed',
    closed: order.status === 'cancelled' || order.status === 'closed',
    remaining_ms: order.status === 'pending' ? remainingMs : 0,
    pay_expired: order.status === 'pending' && remainingMs === 0,
  });
});

module.exports = router;
