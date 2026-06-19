const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/shop.db');
const db = new Database(dbPath);

function columnExists(tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some(c => c.name === columnName);
}

function addColumnIfMissing(table, colDef) {
  const colName = colDef.split(' ')[0];
  if (columnExists(table, colName)) {
    return;
  }
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
    console.log(`🔄 添加字段: ${table}.${colName}`);
  } catch(e) {
    if (e.message.includes('non-constant default')) {
      console.log(`🔄 添加字段 ${table}.${colName}（使用 NULL 默认值兼容旧数据）...`);
      const nullDef = colDef.replace(/DEFAULT\s+CURRENT_TIMESTAMP/i, 'DEFAULT NULL');
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${nullDef}`);
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
      db.exec(`UPDATE ${table} SET ${colName} = ?` , [now]);
      console.log(`🔄 添加字段: ${table}.${colName}（已填充时间）`);
    } else {
      throw e;
    }
  }
}

function migrateSchema() {
  const hasOldStock = columnExists('products', 'stock');
  const hasTotalStock = columnExists('products', 'total_stock');

  if (hasOldStock && !hasTotalStock) {
    console.log('🔄 检测到旧版数据库，开始迁移库存字段...');
    addColumnIfMissing('products', 'total_stock INTEGER DEFAULT 0');
    addColumnIfMissing('products', 'locked_stock INTEGER DEFAULT 0');
    addColumnIfMissing('products', 'sold_stock INTEGER DEFAULT 0');
    db.exec(`UPDATE products SET total_stock = stock WHERE stock IS NOT NULL`);
    db.exec(`UPDATE products SET locked_stock = 0, sold_stock = 0`);
    console.log('✅ 库存字段迁移完成');
  } else {
    addColumnIfMissing('products', 'total_stock INTEGER DEFAULT 0');
    addColumnIfMissing('products', 'locked_stock INTEGER DEFAULT 0');
    addColumnIfMissing('products', 'sold_stock INTEGER DEFAULT 0');
  }

  addColumnIfMissing('products', 'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP');
  addColumnIfMissing('products', 'original_price REAL');
  addColumnIfMissing('products', 'images TEXT DEFAULT \'[]\'');
  addColumnIfMissing('products', 'description TEXT DEFAULT \'\'');

  addColumnIfMissing('orders', 'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP');
  addColumnIfMissing('orders', 'idempotency_key TEXT');
  addColumnIfMissing('orders', 'pay_expire_time DATETIME');
  addColumnIfMissing('orders', 'paid_at DATETIME');
  addColumnIfMissing('orders', 'cancelled_at DATETIME');
  addColumnIfMissing('orders', 'address TEXT DEFAULT \'\'');
  addColumnIfMissing('orders', 'receiver_name TEXT DEFAULT \'\'');
  addColumnIfMissing('orders', 'receiver_phone TEXT DEFAULT \'\'');
  addColumnIfMissing('orders', 'remark TEXT DEFAULT \'\'');
}

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

  // 创建商品表（三库存模型：总库存、预占库存、已售库存）
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price REAL NOT NULL,
      original_price REAL,
      total_stock INTEGER DEFAULT 0,
      locked_stock INTEGER DEFAULT 0,
      sold_stock INTEGER DEFAULT 0,
      category_id INTEGER,
      image TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      status INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    )
  `);

  migrateSchema();

  // 创建订单表
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      total_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      pay_expire_time DATETIME,
      paid_at DATETIME,
      cancelled_at DATETIME,
      address TEXT DEFAULT '',
      receiver_name TEXT DEFAULT '',
      receiver_phone TEXT DEFAULT '',
      remark TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      idempotency_key TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

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

  // 创建库存流水表（用于审计追踪，防双重扣减/回滚）
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      order_id INTEGER,
      order_no TEXT,
      operation_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      before_total_stock INTEGER DEFAULT 0,
      before_locked_stock INTEGER DEFAULT 0,
      before_sold_stock INTEGER DEFAULT 0,
      after_total_stock INTEGER DEFAULT 0,
      after_locked_stock INTEGER DEFAULT 0,
      after_sold_stock INTEGER DEFAULT 0,
      idempotency_key TEXT,
      remark TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )
  `);

  // 为订单表添加 stock_processed 字段标记库存是否已处理，防止重复操作
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_processed_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL UNIQUE,
      order_no TEXT NOT NULL,
      locked INTEGER DEFAULT 0,
      confirmed INTEGER DEFAULT 0,
      released INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )
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
      // 数码产品 - sold_stock 为历史销量，不占用当前库存；当前可售 = total_stock
      { name: 'MacBook Pro 笔记本', description: 'M3芯片 | 14英寸 | 18小时续航', price: 10999, original_price: 11999, total_stock: 50, sold_stock: 12, category_id: 1, image: 'https://cdn.dummyjson.com/product-images/laptops/apple-macbook-pro-14-inch-space-grey/1.webp' },
      { name: 'Samsung Galaxy 手机', description: '高清屏幕 | 快速充电 | 拍照神器', price: 5999, original_price: 6499, total_stock: 200, sold_stock: 45, category_id: 1, image: 'https://cdn.dummyjson.com/product-images/smartphones/samsung-galaxy-s7/1.webp' },
      { name: 'iPhone 充电器', description: '快速充电 | 原装品质 | 安全可靠', price: 199, original_price: 299, total_stock: 500, sold_stock: 120, category_id: 1, image: 'https://cdn.dummyjson.com/product-images/mobile-accessories/apple-iphone-charger/1.webp' },
      // 服装服饰
      { name: '男士格子衬衫', description: '蓝黑格纹 | 纯棉面料 | 商务休闲', price: 159, original_price: 259, total_stock: 300, sold_stock: 68, category_id: 2, image: 'https://cdn.dummyjson.com/product-images/mens-shirts/blue-&-black-check-shirt/1.webp' },
      { name: '男士游戏T恤', description: '电竞风格 | 舒适透气 | 潮流必备', price: 99, original_price: 149, total_stock: 500, sold_stock: 89, category_id: 2, image: 'https://cdn.dummyjson.com/product-images/mens-shirts/gigabyte-aorus-men-tshirt/1.webp' },
      { name: '女士黑色礼服', description: '优雅气质 | 修身版型 | 晚宴首选', price: 599, original_price: 899, total_stock: 100, sold_stock: 23, category_id: 2, image: "https://cdn.dummyjson.com/product-images/womens-dresses/black-women's-gown/1.webp" },
      { name: '女士皮裙套装', description: '时尚前卫 | 优质皮革 | 气场十足', price: 459, original_price: 699, total_stock: 80, sold_stock: 18, category_id: 2, image: 'https://cdn.dummyjson.com/product-images/womens-dresses/corset-leather-with-skirt/1.webp' },
      // 食品饮料
      { name: '新鲜苹果', description: '有机种植 | 脆甜多汁 | 营养健康', price: 15, original_price: 25, total_stock: 1000, sold_stock: 256, category_id: 3, image: 'https://cdn.dummyjson.com/product-images/groceries/apple/1.webp' },
      { name: '精品牛排', description: '澳洲进口 | 雪花纹理 | 鲜嫩多汁', price: 158, original_price: 238, total_stock: 200, sold_stock: 42, category_id: 3, image: 'https://cdn.dummyjson.com/product-images/groceries/beef-steak/1.webp' },
      // 家居生活
      { name: '意式双人床', description: '实木框架 | 欧式设计 | 舒适睡眠', price: 3999, original_price: 4999, total_stock: 30, sold_stock: 8, category_id: 4, image: 'https://cdn.dummyjson.com/product-images/furniture/annibale-colombo-bed/1.webp' },
      { name: '真皮沙发', description: '头层牛皮 | 意式风格 | 客厅首选', price: 6999, original_price: 8999, total_stock: 20, sold_stock: 5, category_id: 4, image: 'https://cdn.dummyjson.com/product-images/furniture/annibale-colombo-sofa/1.webp' },
      { name: '睫毛膏', description: '浓密纤长 | 持久不晕 | 美妆必备', price: 69, original_price: 99, total_stock: 500, sold_stock: 134, category_id: 4, image: 'https://cdn.dummyjson.com/product-images/beauty/essence-mascara-lash-princess/1.webp' },
    ];
    const stmt = db.prepare('INSERT INTO products (name, description, price, original_price, total_stock, locked_stock, sold_stock, category_id, image) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)');
    products.forEach(p => stmt.run(p.name, p.description, p.price, p.original_price, p.total_stock, p.sold_stock, p.category_id, p.image));
    console.log('✅ 示例商品已创建');
  }

  console.log('✅ 数据库初始化完成');
}

module.exports = { db, initDatabase };
