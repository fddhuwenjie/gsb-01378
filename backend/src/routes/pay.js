const express = require('express');
const crypto = require('crypto');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { confirmStockForOrder } = require('../services/stockService');
const { getOrderTimeRemaining } = require('../services/orderTimeoutService');
const logger = require('../utils/logger');

const router = express.Router();

const WECHAT_MOCK_PAY = process.env.WECHAT_MOCK_PAY === 'true';
const WECHAT_APP_ID = process.env.WECHAT_APP_ID;
const WECHAT_MCH_ID = process.env.WECHAT_MCH_ID;
const WECHAT_API_KEY = process.env.WECHAT_API_KEY;
const WECHAT_PAY_NOTIFY_URL = process.env.WECHAT_PAY_NOTIFY_URL;

function generateNonceStr(length = 32) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

function markOrderAsPaid(orderId) {
  const payTransaction = db.transaction((orderId) => {
    const order = db.prepare('SELECT id, order_no, status, stock_confirmed, paid_at, expire_at FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      throw new Error('订单不存在');
    }
    if (order.status === 'paid' && order.stock_confirmed === 1) {
      return { already_paid: true };
    }
    if (order.status !== 'pending') {
      throw new Error('订单状态不正确，当前状态: ' + order.status);
    }

    const timeInfo = getOrderTimeRemaining(order);
    if (timeInfo && timeInfo.expired) {
      throw new Error('订单已超时，请重新下单');
    }

    confirmStockForOrder(orderId);

    const updateResult = db.prepare(`
      UPDATE orders 
      SET status = 'paid', 
          paid_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP 
      WHERE id = ? AND status = 'pending' AND stock_confirmed = 1
    `).run(orderId);

    if (updateResult.changes === 0) {
      const updatedOrder = db.prepare('SELECT id, status, stock_confirmed FROM orders WHERE id = ?').get(orderId);
      if (updatedOrder && updatedOrder.status === 'paid' && updatedOrder.stock_confirmed === 1) {
        return { already_paid: true };
      }
      throw new Error('订单状态更新失败，事务回滚');
    }

    return { already_paid: false };
  });

  return payTransaction(orderId);
}

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

  const timeInfo = getOrderTimeRemaining(order);
  if (timeInfo && timeInfo.expired) {
    return res.status(400).json({ error: '订单已超时，请重新下单' });
  }

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
      },
      time_expire: order.expire_at
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
    logger.error('创建支付订单失败:', err.response?.data || err.message);
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

  try {
    const result = markOrderAsPaid(order_id);
    res.json({ message: '支付成功', ...result });
  } catch (err) {
    logger.error('模拟支付失败:', err);
    res.status(400).json({ error: err.message });
  }
});

router.post('/notify', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const body = JSON.parse(req.body.toString());
    
    if (body.event_type === 'TRANSACTION.SUCCESS') {
      const resource = body.resource;
      let orderNo;

      if (resource.ciphertext) {
        try {
          const apiV3Key = WECHAT_API_KEY;
          const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(resource.nonce, 'base64'));
          const ciphertextBuffer = Buffer.from(resource.ciphertext, 'base64');
          const authTag = ciphertextBuffer.slice(-16);
          const encryptedData = ciphertextBuffer.slice(0, -16);
          decipher.setAuthTag(authTag);
          if (resource.associated_data) {
            decipher.setAAD(Buffer.from(resource.associated_data));
          }
          const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
          const data = JSON.parse(decrypted.toString());
          orderNo = data.out_trade_no;
        } catch (decryptErr) {
          logger.error('解密支付回调失败，尝试直接读取:', decryptErr);
          orderNo = resource.out_trade_no;
        }
      } else {
        orderNo = resource.out_trade_no;
      }

      if (orderNo) {
        const order = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(orderNo);
        if (order) {
          try {
            markOrderAsPaid(order.id);
            logger.info(`支付回调处理成功，订单: ${orderNo}`);
          } catch (payErr) {
            logger.error(`处理订单 ${orderNo} 支付失败:`, payErr.message);
          }
        }
      }
    }

    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    logger.error('支付回调处理失败:', err);
    res.status(500).json({ code: 'FAIL', message: '处理失败' });
  }
});

router.get('/status/:orderId', authMiddleware, (req, res) => {
  const { orderId } = req.params;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.user.id);
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  const timeInfo = getOrderTimeRemaining(order);

  res.json({
    order_id: order.id,
    order_no: order.order_no,
    status: order.status,
    paid: order.status === 'paid',
    expire_at: order.expire_at,
    time_remaining: timeInfo,
    stock_reserved: order.stock_reserved === 1,
    stock_confirmed: order.stock_confirmed === 1
  });
});

module.exports = router;
