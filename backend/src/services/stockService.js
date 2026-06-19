const { db } = require('../database');
const logger = require('../utils/logger');

/**
 * 库存状态机
 * ============================================================
 * 商品库存被拆成三段：
 *   available (products.stock)         —— 可售
 *   reserved  (products.stock_reserved) —— 预占（下单未支付）
 *   sold      (products.stock_sold)     —— 已售（支付成功）
 *
 * 合法迁移：
 *   reserve : available -N, reserved +N    （下单）
 *   commit  : reserved  -N, sold     +N    （支付成功）
 *   release : reserved  -N, available +N   （主动取消）
 *   expire  : reserved  -N, available +N   （超时回收，与 release 数量等价但语义不同）
 *
 * 防止双重扣减 / 双重回滚的核心手段：
 *   1) 所有 UPDATE 语句都自带"前置条件"——例如扣可售时必须 stock >= ?，
 *      回收预占时必须 stock_reserved >= ?。条件不满足时 changes=0，
 *      事务回滚，避免负数库存或凭空增库存。
 *   2) stock_logs(order_id, product_id, action) 加唯一索引。即使外层
 *      因为支付回调和 reaper 同时触发，最多只有一条流水落地，配套的
 *      库存数字也只会被加减一次。
 *   3) 订单状态推进同样是带 WHERE status='xxx' 的乐观更新，
 *      在并发场景下只有一个执行者能把 pending 推到 paid 或 closed。
 */

/**
 * 预占库存（下单时调用）
 * @param {Object} params
 * @param {number} params.orderId
 * @param {string} params.orderNo
 * @param {Array<{product_id:number, quantity:number}>} params.items
 * @returns {{ ok: boolean, conflict?: { product_id: number } }}
 */
function reserveStock({ orderId, orderNo, items }) {
  // 关键 SQL：UPDATE products SET stock = stock - ?, stock_reserved = stock_reserved + ?
  //          WHERE id = ? AND status = 1 AND stock >= ?
  // 这条语句天然避免超卖：库存不足时不会更新成功（changes=0）。
  const decAvailable = db.prepare(
    'UPDATE products SET stock = stock - ?, stock_reserved = stock_reserved + ? ' +
    'WHERE id = ? AND status = 1 AND stock >= ?'
  );
  const insertLog = db.prepare(
    'INSERT OR IGNORE INTO stock_logs (order_id, order_no, product_id, action, quantity, remark) ' +
    'VALUES (?, ?, ?, ?, ?, ?)'
  );

  const txn = db.transaction(() => {
    for (const it of items) {
      const r = decAvailable.run(it.quantity, it.quantity, it.product_id, it.quantity);
      if (r.changes === 0) {
        // 库存不足：抛出带 product_id 的错误，外层捕获后整笔事务回滚
        const err = new Error('STOCK_NOT_ENOUGH');
        err.product_id = it.product_id;
        throw err;
      }
      insertLog.run(orderId, orderNo, it.product_id, 'reserve', it.quantity, '');
    }
  });

  try {
    txn();
    return { ok: true };
  } catch (err) {
    if (err.message === 'STOCK_NOT_ENOUGH') {
      return { ok: false, conflict: { product_id: err.product_id } };
    }
    throw err;
  }
}

/**
 * 提交库存（预占 -> 已售）
 * 同时把订单从 pending 推进到 paid。
 * 整个过程在单事务内通过乐观锁完成；若该订单状态已不再是 pending，则 noop。
 * @returns {{ ok: boolean, alreadyDone?: boolean, expired?: boolean }}
 */
function commitStock({ orderId }) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { ok: false };

  // 兜底：状态已经流转就直接返回，避免重复扣减
  if (order.status === 'paid') return { ok: true, alreadyDone: true };
  if (order.status === 'cancelled' || order.status === 'closed') {
    return { ok: false, expired: true };
  }
  if (order.status !== 'pending') return { ok: false };

  const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(orderId);

  // 状态推进：用 WHERE status='pending' 实现乐观锁，保证并发回调下只成功一次
  const promote = db.prepare(
    "UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP " +
    "WHERE id = ? AND status = 'pending'"
  );
  const moveReservedToSold = db.prepare(
    'UPDATE products SET stock_reserved = stock_reserved - ?, stock_sold = stock_sold + ?, sales = sales + ? ' +
    'WHERE id = ? AND stock_reserved >= ?'
  );
  const insertLog = db.prepare(
    'INSERT OR IGNORE INTO stock_logs (order_id, order_no, product_id, action, quantity, remark) ' +
    'VALUES (?, ?, ?, ?, ?, ?)'
  );

  let promoted = false;
  const txn = db.transaction(() => {
    const r = promote.run(orderId);
    if (r.changes === 0) {
      // 别的路径已经动过了，整个事务什么都不做
      return;
    }
    promoted = true;
    for (const it of items) {
      // 唯一索引保证只迁一次：先尝试落流水，若 changes=0 说明之前已 commit 过
      const logR = insertLog.run(order.id, order.order_no, it.product_id, 'commit', it.quantity, '');
      if (logR.changes === 0) continue;
      const sR = moveReservedToSold.run(it.quantity, it.quantity, it.quantity, it.product_id, it.quantity);
      if (sR.changes === 0) {
        // reserved 不足 —— 数据严重失衡，立刻终止整笔事务以保护不变量
        throw new Error('RESERVED_UNDERFLOW:' + it.product_id);
      }
    }
  });

  try {
    txn();
    return { ok: promoted, alreadyDone: !promoted };
  } catch (err) {
    logger.error('[stockService] commitStock 失败 orderId=' + orderId + ' err=' + err.message);
    throw err;
  }
}

/**
 * 释放库存（预占 -> 可售），用于用户主动取消
 * @returns {{ ok: boolean, alreadyDone?: boolean }}
 */
function releaseStock({ orderId, reason = 'cancel' }) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { ok: false };
  if (order.status !== 'pending') {
    // 已支付/已取消/已关闭，不允许再回滚（避免双重回滚）
    return { ok: false, alreadyDone: true };
  }

  const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(orderId);

  const targetStatus = reason === 'expire' ? 'closed' : 'cancelled';
  const action = reason === 'expire' ? 'expire' : 'release';

  const promote = db.prepare(
    "UPDATE orders SET status = ?, closed_at = CURRENT_TIMESTAMP " +
    "WHERE id = ? AND status = 'pending'"
  );
  const restoreAvailable = db.prepare(
    'UPDATE products SET stock = stock + ?, stock_reserved = stock_reserved - ? ' +
    'WHERE id = ? AND stock_reserved >= ?'
  );
  const insertLog = db.prepare(
    'INSERT OR IGNORE INTO stock_logs (order_id, order_no, product_id, action, quantity, remark) ' +
    'VALUES (?, ?, ?, ?, ?, ?)'
  );

  let promoted = false;
  const txn = db.transaction(() => {
    const r = promote.run(targetStatus, orderId);
    if (r.changes === 0) {
      return;
    }
    promoted = true;
    for (const it of items) {
      const logR = insertLog.run(order.id, order.order_no, it.product_id, action, it.quantity, reason);
      if (logR.changes === 0) continue;
      const sR = restoreAvailable.run(it.quantity, it.quantity, it.product_id, it.quantity);
      if (sR.changes === 0) {
        throw new Error('RESERVED_UNDERFLOW:' + it.product_id);
      }
    }
  });

  try {
    txn();
    return { ok: promoted, alreadyDone: !promoted };
  } catch (err) {
    logger.error('[stockService] releaseStock 失败 orderId=' + orderId + ' err=' + err.message);
    throw err;
  }
}

/**
 * 被动过期检查 —— 任何读到该订单的接口（支付查询、订单详情、发起支付前）都可以调用。
 * 只在订单为 pending 且 expire_at 已到时执行 release(reason='expire')。
 */
function expireIfNeeded(orderId) {
  const order = db.prepare('SELECT id, status, expire_at FROM orders WHERE id = ?').get(orderId);
  if (!order) return { expired: false };
  if (order.status !== 'pending') return { expired: false };
  if (!order.expire_at) return { expired: false };
  const expireMs = new Date(order.expire_at + 'Z').getTime();
  if (Number.isNaN(expireMs)) return { expired: false };
  if (Date.now() < expireMs) return { expired: false };
  const r = releaseStock({ orderId, reason: 'expire' });
  return { expired: r.ok || r.alreadyDone };
}

module.exports = {
  reserveStock,
  commitStock,
  releaseStock,
  expireIfNeeded,
};
