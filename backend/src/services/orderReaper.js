const { db } = require('../database');
const { releaseStock } = require('./stockService');
const logger = require('../utils/logger');

/**
 * 订单超时回收任务（reaper）
 * ============================================================
 * 触发时机：进程内定时器，默认每 30 秒扫一次。
 *
 * 回收策略：
 *   1) 找出 status='pending' 且 expire_at <= now 的订单。
 *   2) 对每一笔订单调用 stockService.releaseStock(reason='expire')。
 *      该函数内部已经通过乐观锁 + stock_logs 唯一索引保证：
 *        - 同一订单只会成功推进一次（pending -> closed）
 *        - 即便用户在同一秒去支付/取消，最多只有一个路径生效
 *   3) reaper 不读不写 order_items 库存数字（已封装）。
 *
 * 与支付回调的竞态控制：
 *   - 支付回调走 stockService.commitStock；它也是 WHERE status='pending' 推进。
 *   - 如果 reaper 抢先把订单关掉，commitStock 会拿到 alreadyDone=false 且
 *     状态读到 closed/cancelled，从而返回 expired=true，调用方应该走"支付成功
 *     但订单已关闭"的退款分支（这里 mock 环境直接返回错误）。
 *   - 如果支付回调先成功，reaper 这边 promote.changes=0，整笔事务不会再
 *     去动 stock_reserved，因此不会出现"已 commit 又被 release"的双重回滚。
 */

const REAPER_INTERVAL_MS = parseInt(process.env.ORDER_REAPER_INTERVAL_MS || '30000', 10);
const REAPER_BATCH = parseInt(process.env.ORDER_REAPER_BATCH || '200', 10);

let timer = null;

function runOnce() {
  try {
    // 注意 SQLite 默认存的 created_at/expire_at 是 UTC 文本，CURRENT_TIMESTAMP 也是 UTC，
    // 这里用 datetime('now') 与 expire_at 在同一时区作比较。
    const rows = db.prepare(
      "SELECT id FROM orders WHERE status = 'pending' AND expire_at IS NOT NULL " +
      "AND expire_at <= datetime('now') LIMIT ?"
    ).all(REAPER_BATCH);

    if (rows.length === 0) return;

    let success = 0;
    let alreadyDone = 0;
    for (const row of rows) {
      try {
        const r = releaseStock({ orderId: row.id, reason: 'expire' });
        if (r.ok) success++;
        else if (r.alreadyDone) alreadyDone++;
      } catch (err) {
        logger.error('[reaper] 释放订单失败 orderId=' + row.id + ' err=' + err.message);
      }
    }
    logger.info(`[reaper] 扫描完成: 候选=${rows.length} 关闭=${success} 已处理=${alreadyDone}`);
  } catch (err) {
    logger.error('[reaper] 扫描异常: ' + err.message);
  }
}

function start() {
  if (timer) return;
  timer = setInterval(runOnce, REAPER_INTERVAL_MS);
  logger.info(`[reaper] 订单超时回收任务已启动，间隔 ${REAPER_INTERVAL_MS}ms`);
  // 启动时立刻跑一次，处理进程重启期间堆积的过期订单
  runOnce();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, runOnce };
