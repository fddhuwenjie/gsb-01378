const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/shop.db');
const db = new Database(dbPath);

function initDatabase() {
  // 创建用户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT UNIQUE,
      username TEXT UNIQUE,
      password TEXT,
      nickname TEXT DEFAULT '用户',
      avatar TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 创建分类表
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 创建商品表
  // 库存模型说明：
  //   stock          —— 可售库存（available）。用户下单时从这里扣减。
  //   stock_reserved —— 预占库存（reserved）。下单成功但未支付的部分。
  //   stock_sold     —— 已售库存（sold）。支付成功后从 reserved 转入 sold。
  // 不变量：可售库存 + 预占库存 + 已售库存 = 商品总库存（恒等且非负）
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price REAL NOT NULL,
      original_price REAL,
      stock INTEGER DEFAULT 0,
      stock_reserved INTEGER DEFAULT 0,
      stock_sold INTEGER DEFAULT 0,
      sales INTEGER DEFAULT 0,
      category_id INTEGER,
      image TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      status INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    )
  `);

  // 历史库兼容：为已存在的 products 表补齐 stock_reserved / stock_sold 列
  const productCols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
  if (!productCols.includes('stock_reserved')) {
    db.exec('ALTER TABLE products ADD COLUMN stock_reserved INTEGER DEFAULT 0');
  }
  if (!productCols.includes('stock_sold')) {
    db.exec('ALTER TABLE products ADD COLUMN stock_sold INTEGER DEFAULT 0');
  }

  // 创建订单表
  // 状态机（含库存联动）：
  //   pending  -> paid       支付成功：reserved 转 sold
  //   pending  -> cancelled  用户取消：reserved 回到 available
  //   pending  -> closed     超时关闭：reserved 回到 available（reaper 触发）
  //   paid     -> shipped    管理员发货
  //   shipped  -> completed  完成
  // expire_at         订单支付截止时间（超时未支付将被 reaper 自动关闭并回收预占）
  // paid_at/closed_at 记录状态推进的实际时间，方便审计与排障
  // idempotency_key   下单幂等键，防止用户多次点击造成重复扣库存
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      total_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      address TEXT DEFAULT '',
      receiver_name TEXT DEFAULT '',
      receiver_phone TEXT DEFAULT '',
      remark TEXT DEFAULT '',
      expire_at DATETIME,
      paid_at DATETIME,
      closed_at DATETIME,
      idempotency_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 历史库兼容：为已存在的 orders 表补齐新字段
  const orderCols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
  if (!orderCols.includes('expire_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN expire_at DATETIME');
  }
  if (!orderCols.includes('paid_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN paid_at DATETIME');
  }
  if (!orderCols.includes('closed_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN closed_at DATETIME');
  }
  if (!orderCols.includes('idempotency_key')) {
    db.exec('ALTER TABLE orders ADD COLUMN idempotency_key TEXT');
  }
  // 幂等键索引：同一用户的 idempotency_key 唯一
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
  // expire_at 上的扫描索引，加速 reaper
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_expire ON orders(status, expire_at)');

  // 创建订单项表
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      product_image TEXT DEFAULT '',
      quantity INTEGER NOT NULL,
      price REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  // 创建购物车表
  db.exec(`
    CREATE TABLE IF NOT EXISTS cart (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      UNIQUE(user_id, product_id)
    )
  `);

  // 创建收货地址表
  db.exec(`
    CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      region TEXT NOT NULL,
      detail TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 创建库存流水表
  // 每一次库存状态迁移都落一条流水，便于：
  //   1) 排查超卖/重复扣减/重复回滚
  //   2) 后台审计可售/预占/已售的变化轨迹
  // action 取值：
  //   reserve   下单预占（available -1，reserved +1）
  //   commit    支付成功（reserved -1，sold +1）
  //   release   取消订单（reserved -1，available +1）
  //   expire    超时回收（reserved -1，available +1）
  // 通过 (order_id, product_id, action) 唯一索引，保证同一订单同一动作只会写入一次，
  // 即便事务因竞态被多次触发，库存数字也不会被重复加减。
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      order_no TEXT,
      product_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      remark TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_logs_uniq ON stock_logs(order_id, product_id, action)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_stock_logs_product ON stock_logs(product_id, created_at)');

  // 插入默认管理员账号
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password, nickname, role) VALUES (?, ?, ?, ?)').run('admin', hashedPassword, '管理员', 'admin');
    console.log('✅ 默认管理员账号已创建: admin / admin123');
  }

  // 插入示例分类
  const categoryCount = db.prepare('SELECT COUNT(*) as count FROM categories').get();
  if (categoryCount.count === 0) {
    const categories = [
      { name: '数码产品', icon: '📱', sort_order: 1 },
      { name: '服装服饰', icon: '👕', sort_order: 2 },
      { name: '食品饮料', icon: '🍔', sort_order: 3 },
      { name: '家居生活', icon: '🏠', sort_order: 4 },
    ];
    const stmt = db.prepare('INSERT INTO categories (name, icon, sort_order) VALUES (?, ?, ?)');
    categories.forEach(c => stmt.run(c.name, c.icon, c.sort_order));
    console.log('✅ 示例分类已创建');
  }

  // 插入示例商品 (使用 dummyjson.com 真实商品图片 - 正确URL格式)
  const productCount = db.prepare('SELECT COUNT(*) as count FROM products').get();
  if (productCount.count === 0) {
    const products = [
      // 数码产品
      { name: 'MacBook Pro 笔记本', description: 'M3芯片 | 14英寸 | 18小时续航', price: 10999, original_price: 11999, stock: 50, sales: 890, category_id: 1, image: 'https://cdn.dummyjson.com/product-images/laptops/apple-macbook-pro-14-inch-space-grey/1.webp' },
      { name: 'Samsung Galaxy 手机', description: '高清屏幕 | 快速充电 | 拍照神器', price: 5999, original_price: 6499, stock: 200, sales: 5620, category_id: 1, image: 'https://cdn.dummyjson.com/product-images/smartphones/samsung-galaxy-s7/1.webp' },
      { name: 'iPhone 充电器', description: '快速充电 | 原装品质 | 安全可靠', price: 199, original_price: 299, stock: 500, sales: 8900, category_id: 1, image: 'https://cdn.dummyjson.com/product-images/mobile-accessories/apple-iphone-charger/1.webp' },
      // 服装服饰
      { name: '男士格子衬衫', description: '蓝黑格纹 | 纯棉面料 | 商务休闲', price: 159, original_price: 259, stock: 300, sales: 4560, category_id: 2, image: 'https://cdn.dummyjson.com/product-images/mens-shirts/blue-&-black-check-shirt/1.webp' },
      { name: '男士游戏T恤', description: '电竞风格 | 舒适透气 | 潮流必备', price: 99, original_price: 149, stock: 500, sales: 6780, category_id: 2, image: 'https://cdn.dummyjson.com/product-images/mens-shirts/gigabyte-aorus-men-tshirt/1.webp' },
      { name: '女士黑色礼服', description: '优雅气质 | 修身版型 | 晚宴首选', price: 599, original_price: 899, stock: 100, sales: 2340, category_id: 2, image: "https://cdn.dummyjson.com/product-images/womens-dresses/black-women's-gown/1.webp" },
      { name: '女士皮裙套装', description: '时尚前卫 | 优质皮革 | 气场十足', price: 459, original_price: 699, stock: 80, sales: 1890, category_id: 2, image: 'https://cdn.dummyjson.com/product-images/womens-dresses/corset-leather-with-skirt/1.webp' },
      // 食品饮料
      { name: '新鲜苹果', description: '有机种植 | 脆甜多汁 | 营养健康', price: 15, original_price: 25, stock: 1000, sales: 12000, category_id: 3, image: 'https://cdn.dummyjson.com/product-images/groceries/apple/1.webp' },
      { name: '精品牛排', description: '澳洲进口 | 雪花纹理 | 鲜嫩多汁', price: 158, original_price: 238, stock: 200, sales: 3450, category_id: 3, image: 'https://cdn.dummyjson.com/product-images/groceries/beef-steak/1.webp' },
      // 家居生活
      { name: '意式双人床', description: '实木框架 | 欧式设计 | 舒适睡眠', price: 3999, original_price: 4999, stock: 30, sales: 560, category_id: 4, image: 'https://cdn.dummyjson.com/product-images/furniture/annibale-colombo-bed/1.webp' },
      { name: '真皮沙发', description: '头层牛皮 | 意式风格 | 客厅首选', price: 6999, original_price: 8999, stock: 20, sales: 320, category_id: 4, image: 'https://cdn.dummyjson.com/product-images/furniture/annibale-colombo-sofa/1.webp' },
      { name: '睫毛膏', description: '浓密纤长 | 持久不晕 | 美妆必备', price: 69, original_price: 99, stock: 500, sales: 7800, category_id: 4, image: 'https://cdn.dummyjson.com/product-images/beauty/essence-mascara-lash-princess/1.webp' },
    ];
    const stmt = db.prepare('INSERT INTO products (name, description, price, original_price, stock, sales, category_id, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    products.forEach(p => stmt.run(p.name, p.description, p.price, p.original_price, p.stock, p.sales, p.category_id, p.image));
    console.log('✅ 示例商品已创建');
  }

  console.log('✅ 数据库初始化完成');
}

module.exports = { db, initDatabase };
