const express = require('express');
const crypto = require('crypto');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const inventoryService = require('../services/inventoryService');
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

function processPaymentSuccess(orderId, transactionId = null, rawData = null) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    throw new Error('订单不存在');
  }

  const existingPayment = db.prepare('SELECT id FROM payment_records WHERE order_id = ? AND status = ?').get(orderId, 'success');
  if (existingPayment) {
    logger.info(`订单 ${order.order_no} 已存在支付记录，幂等返回`);
    return { alreadyProcessed: true, order };
  }

  if (order.stock_processed === 1) {
    logger.info(`订单 ${order.order_no} 库存已处理`);
    return { alreadyProcessed: true, order };
  }

  if (order.status === 'timeout' || order.status === 'cancelled') {
    logger.warn(`订单 ${order.order_no} 已超时/取消，无法支付`);
    throw new Error('订单已关闭，无法支付');
  }

  const paymentIdempotentKey = inventoryService.generateIdempotentKey('pay', orderId, transactionId || Date.now());

  const tx = db.transaction(() => {
    try {
      db.prepare(`
        INSERT INTO payment_records (order_id, order_no, transaction_id, amount, status, idempotent_key, raw_data)
        VALUES (?, ?, ?, ?, 'success', ?, ?)
      `).run(orderId, order.order_no, transactionId, order.total_amount, paymentIdempotentKey, rawData ? JSON.stringify(rawData) : null);
    } catch (err) {
      if (!err.message.includes('UNIQUE')) {
        throw err;
      }
      logger.info(`支付记录已存在，幂等跳过`);
    }

    const updateResult = db.prepare(`
      UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (status = 'pending' OR status = 'paid')
    `).run(orderId);

    if (updateResult.changes === 0) {
      const currentOrder = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
      if (currentOrder && currentOrder.status === 'paid') {
        logger.info(`订单 ${order.order_no} 已是已支付状态`);
        return;
      }
      throw new Error(`订单状态更新失败，当前状态: ${currentOrder?.status}`);
    }

    inventoryService.confirmStockDeduction(orderId, order.order_no, transactionId);
  });

  tx();

  const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  return { alreadyProcessed: false, order: updatedOrder };
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
    if (order.status === 'paid') {
      return res.status(400).json({ error: '订单已支付' });
    }
    if (order.status === 'timeout' || order.status === 'cancelled') {
      return res.status(400).json({ error: '订单已关闭' });
    }
    return res.status(400).json({ error: '订单状态不正确' });
  }

  const now = Date.now();
  const expireTime = order.pay_expire_time ? new Date(order.pay_expire_time).getTime() : 0;
  if (expireTime > 0 && expireTime < now) {
    try {
      const tx = db.transaction(() => {
        db.prepare(`UPDATE orders SET status = 'timeout', cancelled_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`).run(order_id);
      });
      tx();
      inventoryService.releaseStock(order.id, order.order_no, '支付超时');
      return res.status(400).json({ error: '订单已超时，请重新下单' });
    } catch (err) {
      logger.error('处理超时订单失败:', err);
    }
    return res.status(400).json({ error: '订单已超时，请重新下单' });
  }

  if (WECHAT_MOCK_PAY) {
    const mockPayData = {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: generateNonceStr(),
      package: 'prepay_id=mock_prepay_' + Date.now(),
      signType: 'RSA',
      paySign: 'mock_sign_' + generateNonceStr(16),
      mock: true,
      order_id: order_id,
      remaining_pay_seconds: Math.max(0, Math.floor((expireTime - now) / 1000)),
      pay_expire_time: order.pay_expire_time
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
      time_expire: new Date(expireTime).toISOString(),
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
      remaining_pay_seconds: Math.max(0, Math.floor((expireTime - now) / 1000))
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

  if (order.status === 'paid') {
    return res.json({ message: '支付成功（幂等）', already_paid: true });
  }

  if (order.status !== 'pending') {
    return res.status(400).json({ error: '订单状态不正确' });
  }

  try {
    const mockTransactionId = 'mock_txn_' + Date.now();
    processPaymentSuccess(order_id, mockTransactionId, { mock: true });
    res.json({ message: '支付成功' });
  } catch (err) {
    console.error('模拟支付失败:', err);
    res.status(400).json({ error: err.message || '支付失败' });
  }
});

router.post('/notify', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const body = JSON.parse(req.body.toString());
    
    if (body.event_type === 'TRANSACTION.SUCCESS') {
      const resource = body.resource;
      
      let orderNo;
      let transactionId;
      let decryptedData = {};

      try {
        if (resource.ciphertext && WECHAT_API_KEY) {
          const { decryptResource } = require('../utils/wechatPay');
          decryptedData = decryptResource(resource, WECHAT_API_KEY);
          orderNo = decryptedData.out_trade_no;
          transactionId = decryptedData.transaction_id;
        } else {
          orderNo = resource.out_trade_no || body.out_trade_no;
          transactionId = body.transaction_id || ('callback_' + Date.now());
        }
      } catch (decryptErr) {
        logger.error('解密支付回调数据失败，尝试直接读取:', decryptErr.message);
        orderNo = resource.out_trade_no || body.out_trade_no;
        transactionId = body.transaction_id || ('callback_' + Date.now());
      }

      if (!orderNo) {
        logger.error('支付回调无法获取订单号');
        return res.json({ code: 'FAIL', message: '订单号不存在' });
      }

      const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
      if (!order) {
        logger.error(`支付回调：订单 ${orderNo} 不存在`);
        return res.json({ code: 'SUCCESS', message: '订单不存在（已处理）' });
      }

      try {
        processPaymentSuccess(order.id, transactionId, decryptedData);
        logger.info(`支付回调处理成功: 订单 ${orderNo}, 交易号 ${transactionId}`);
      } catch (processErr) {
        logger.error(`支付回调处理失败: 订单 ${orderNo}`, processErr.message);
        if (!processErr.message.includes('已关闭')) {
          return res.json({ code: 'FAIL', message: '处理失败，稍后重试' });
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
  const order = db.prepare('SELECT id, order_no, status, total_amount, pay_expire_time, paid_at, stock_processed FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.user.id);
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  const now = Date.now();
  const expireTime = order.pay_expire_time ? new Date(order.pay_expire_time).getTime() : 0;
  const remainingSeconds = order.status === 'pending' && expireTime > 0
    ? Math.max(0, Math.floor((expireTime - now) / 1000))
    : 0;

  res.json({
    order_id: order.id,
    order_no: order.order_no,
    status: order.status,
    paid: order.status === 'paid',
    stock_processed: order.stock_processed === 1,
    paid_at: order.paid_at,
    pay_expire_time: order.pay_expire_time,
    remaining_pay_seconds: remainingSeconds,
    is_expired: remainingSeconds === 0 && order.status === 'pending'
  });
});

module.exports = router;
