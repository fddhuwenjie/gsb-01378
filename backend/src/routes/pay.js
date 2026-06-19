const express = require('express');
const crypto = require('crypto');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const stockService = require('../services/stockService');

const router = express.Router();

const WECHAT_MOCK_PAY = process.env.WECHAT_MOCK_PAY === 'true';
const WECHAT_APP_ID = process.env.WECHAT_APP_ID;
const WECHAT_MCH_ID = process.env.WECHAT_MCH_ID;
const WECHAT_API_KEY = process.env.WECHAT_API_KEY;
const WECHAT_PAY_NOTIFY_URL = process.env.WECHAT_PAY_NOTIFY_URL;

function generateNonceStr(length = 32) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

router.post('/create', authMiddleware, async (req, res) => {
  const { order_id } = req.body;

  if (!order_id) {
    return res.status(400).json({ error: '缺少订单ID' });
  }

  stockService.scanAndCloseTimeoutOrders();

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order_id, req.user.id);
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status === 'timeout' || order.status === 'cancelled') {
    return res.status(400).json({ error: '订单已关闭，请重新下单', order_status: order.status });
  }

  if (order.status !== 'pending') {
    if (order.status === 'paid' || order.status === 'shipped' || order.status === 'completed') {
      return res.json({ already_paid: true, message: '订单已支付' });
    }
    return res.status(400).json({ error: '订单状态不正确' });
  }

  if (order.pay_expire_time) {
    const expireTime = new Date(order.pay_expire_time);
    if (new Date() > expireTime) {
      stockService.timeoutOrder(order.id);
      return res.status(400).json({ error: '订单已超时，请重新下单', order_status: 'timeout' });
    }
  }

  if (WECHAT_MOCK_PAY) {
    const mockPayData = {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: generateNonceStr(),
      package: 'prepay_id=mock_prepay_' + Date.now(),
      signType: 'RSA',
      paySign: 'mock_sign_' + generateNonceStr(16),
      mock: true,
      pay_expire_remaining: order.pay_expire_time 
        ? Math.max(0, Math.floor((new Date(order.pay_expire_time).getTime() - Date.now()) / 1000))
        : 1800
    };
    return res.json(mockPayData);
  }

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
      paySign: paySignature,
      pay_expire_remaining: order.pay_expire_time 
        ? Math.max(0, Math.floor((new Date(order.pay_expire_time).getTime() - Date.now()) / 1000))
        : 1800
    });

  } catch (err) {
    console.error('创建支付订单失败:', err.response?.data || err.message);
    res.status(500).json({ error: '创建支付订单失败' });
  }
});

router.post('/mock-success', authMiddleware, (req, res) => {
  if (!WECHAT_MOCK_PAY) {
    return res.status(400).json({ error: '非模拟支付环境' });
  }

  const { order_id } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order_id, req.user.id);
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status === 'timeout' || order.status === 'cancelled') {
    return res.status(400).json({ error: '订单已关闭，无法支付' });
  }

  try {
    const result = stockService.confirmOrderPaid(order.order_no);
    if (result.alreadyProcessed) {
      return res.json({ message: '订单已支付（幂等返回）', alreadyProcessed: true });
    }
    res.json({ message: '支付成功' });
  } catch (err) {
    console.error('支付处理失败:', err);
    res.status(400).json({ error: err.message });
  }
});

router.post('/notify', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const body = JSON.parse(req.body.toString());
    
    if (body.event_type === 'TRANSACTION.SUCCESS') {
      const resource = body.resource;
      
      let orderNo;
      try {
        if (resource.out_trade_no) {
          orderNo = resource.out_trade_no;
        } else if (resource.ciphertext) {
          orderNo = resource.out_trade_no;
        }
      } catch (e) {
        console.error('解析支付回调数据失败:', e);
      }

      if (orderNo) {
        try {
          const result = stockService.confirmOrderPaid(orderNo);
          if (result.alreadyProcessed) {
            console.log(`[PayNotify] 订单 ${orderNo} 已处理过，幂等跳过`);
          } else {
            console.log(`[PayNotify] 订单 ${orderNo} 支付成功，库存已确认`);
          }
        } catch (err) {
          console.error(`[PayNotify] 处理订单 ${orderNo} 失败:`, err.message);
        }
      }
    }

    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('支付回调处理失败:', err);
    res.status(500).json({ code: 'FAIL', message: '处理失败' });
  }
});

router.get('/status/:orderId', authMiddleware, (req, res) => {
  const { orderId } = req.params;

  stockService.scanAndCloseTimeoutOrders();

  const order = db.prepare('SELECT id, order_no, status, total_amount, pay_expire_time FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.user.id);
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  let payExpireRemaining = 0;
  let payExpired = false;
  if (order.pay_expire_time && order.status === 'pending') {
    const expireTime = new Date(order.pay_expire_time);
    payExpireRemaining = Math.max(0, Math.floor((expireTime.getTime() - Date.now()) / 1000));
    payExpired = payExpireRemaining <= 0;
    
    if (payExpired) {
      stockService.timeoutOrder(order.id);
      order.status = 'timeout';
    }
  }

  res.json({
    order_id: order.id,
    order_no: order.order_no,
    status: order.status,
    paid: order.status !== 'pending' && order.status !== 'cancelled' && order.status !== 'timeout',
    pay_expire_remaining: payExpireRemaining,
    pay_expired: payExpired
  });
});

module.exports = router;
