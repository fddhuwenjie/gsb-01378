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
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price REAL NOT NULL,
      original_price REAL,
      stock INTEGER DEFAULT 0,
      reserved_stock INTEGER DEFAULT 0,
      sales INTEGER DEFAULT 0,
      category_id INTEGER,
      image TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      status INTEGER DEFAULT 1,
      version INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    )
  `);

  // 迁移已有商品数据：添加reserved_stock字段（如果表已存在但没有该字段）
  const columns = db.prepare("PRAGMA table_info(products)").all();
  const columnNames = columns.map(c => c.name);
  if (!columnNames.includes('reserved_stock')) {
    db.exec('ALTER TABLE products ADD COLUMN reserved_stock INTEGER DEFAULT 0');
    console.log('✅ 已添加 reserved_stock 字段到 products 表');
  }
  if (!columnNames.includes('version')) {
    db.exec('ALTER TABLE products ADD COLUMN version INTEGER DEFAULT 0');
    console.log('✅ 已添加 version 字段到 products 表');
  }

  // 创建订单表
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
      idempotent_key TEXT UNIQUE,
      pay_expire_time DATETIME,
      paid_at DATETIME,
      cancelled_at DATETIME,
      stock_locked INTEGER DEFAULT 0,
      stock_processed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 迁移已有订单表添加新字段
  const orderColumns = db.prepare("PRAGMA table_info(orders)").all();
  const orderColumnNames = orderColumns.map(c => c.name);
  if (!orderColumnNames.includes('pay_expire_time')) {
    db.exec('ALTER TABLE orders ADD COLUMN pay_expire_time DATETIME');
    console.log('✅ 已添加 pay_expire_time 字段到 orders 表');
  }
  if (!orderColumnNames.includes('paid_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN paid_at DATETIME');
    console.log('✅ 已添加 paid_at 字段到 orders 表');
  }
  if (!orderColumnNames.includes('cancelled_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN cancelled_at DATETIME');
    console.log('✅ 已添加 cancelled_at 字段到 orders 表');
  }
  if (!orderColumnNames.includes('stock_locked')) {
    db.exec('ALTER TABLE orders ADD COLUMN stock_locked INTEGER DEFAULT 0');
    console.log('✅ 已添加 stock_locked 字段到 orders 表');
  }
  if (!orderColumnNames.includes('stock_processed')) {
    db.exec('ALTER TABLE orders ADD COLUMN stock_processed INTEGER DEFAULT 0');
    console.log('✅ 已添加 stock_processed 字段到 orders 表');
  }
  if (!orderColumnNames.includes('idempotent_key')) {
    db.exec('ALTER TABLE orders ADD COLUMN idempotent_key TEXT');
    console.log('✅ 已添加 idempotent_key 字段到 orders 表');
  }

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

  // 创建库存流水表 - 用于追踪所有库存变更，保证幂等性和可审计
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      order_no TEXT,
      product_id INTEGER NOT NULL,
      product_name TEXT,
      quantity INTEGER NOT NULL,
      type TEXT NOT NULL,
      idempotent_key TEXT UNIQUE,
      remark TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  // 创建支付记录表 - 保证支付回调幂等性
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      order_no TEXT NOT NULL,
      transaction_id TEXT,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'success',
      idempotent_key TEXT UNIQUE,
      paid_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      raw_data TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )
  `);

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_status_expire ON orders(status, pay_expire_time);
    CREATE INDEX IF NOT EXISTS idx_stock_logs_order ON stock_logs(order_id);
    CREATE INDEX IF NOT EXISTS idx_stock_logs_product ON stock_logs(product_id);
    CREATE INDEX IF NOT EXISTS idx_payment_records_order ON payment_records(order_id);
  `);

  // 创建幂等性唯一索引（SQLite兼容方式：ALTER TABLE ADD COLUMN不支持UNIQUE，需单独建索引）
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotent_key ON orders(idempotent_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_logs_idempotent_key ON stock_logs(idempotent_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_records_idempotent_key ON payment_records(idempotent_key);
  `);

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
