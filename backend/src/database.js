const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/shop.db');
const db = new Database(dbPath);

const ORDER_TIMEOUT_MINUTES = parseInt(process.env.ORDER_TIMEOUT_MINUTES || '30', 10);

function initDatabase() {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price REAL NOT NULL,
      original_price REAL,
      available_stock INTEGER DEFAULT 0,
      reserved_stock INTEGER DEFAULT 0,
      sold_stock INTEGER DEFAULT 0,
      category_id INTEGER,
      image TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      status INTEGER DEFAULT 1,
      version INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    )
  `);

  const productsColumns = db.prepare("PRAGMA table_info(products)").all();
  const columnNames = productsColumns.map(c => c.name);
  
  if (!columnNames.includes('available_stock')) {
    db.exec('ALTER TABLE products ADD COLUMN available_stock INTEGER DEFAULT 0');
  }
  if (!columnNames.includes('reserved_stock')) {
    db.exec('ALTER TABLE products ADD COLUMN reserved_stock INTEGER DEFAULT 0');
  }
  if (!columnNames.includes('sold_stock')) {
    db.exec('ALTER TABLE products ADD COLUMN sold_stock INTEGER DEFAULT 0');
  }
  if (!columnNames.includes('version')) {
    db.exec('ALTER TABLE products ADD COLUMN version INTEGER DEFAULT 0');
  }
  if (columnNames.includes('stock') && !columnNames.includes('stock_migrated')) {
    db.exec('UPDATE products SET available_stock = stock WHERE available_stock = 0');
  }
  if (columnNames.includes('sales') && !columnNames.includes('sales_migrated')) {
    db.exec('UPDATE products SET sold_stock = sales WHERE sold_stock = 0');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      idempotency_key TEXT,
      total_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      address TEXT DEFAULT '',
      receiver_name TEXT DEFAULT '',
      receiver_phone TEXT DEFAULT '',
      remark TEXT DEFAULT '',
      expire_at DATETIME,
      stock_reserved INTEGER DEFAULT 0,
      stock_confirmed INTEGER DEFAULT 0,
      stock_released INTEGER DEFAULT 0,
      version INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at DATETIME,
      cancelled_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, idempotency_key)
    )
  `);

  const ordersColumns = db.prepare("PRAGMA table_info(orders)").all();
  const orderColumnNames = ordersColumns.map(c => c.name);
  
  if (!orderColumnNames.includes('expire_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN expire_at DATETIME');
  }
  if (!orderColumnNames.includes('stock_reserved')) {
    db.exec('ALTER TABLE orders ADD COLUMN stock_reserved INTEGER DEFAULT 0');
  }
  if (!orderColumnNames.includes('stock_confirmed')) {
    db.exec('ALTER TABLE orders ADD COLUMN stock_confirmed INTEGER DEFAULT 0');
  }
  if (!orderColumnNames.includes('stock_released')) {
    db.exec('ALTER TABLE orders ADD COLUMN stock_released INTEGER DEFAULT 0');
  }
  if (!orderColumnNames.includes('version')) {
    db.exec('ALTER TABLE orders ADD COLUMN version INTEGER DEFAULT 0');
  }
  if (!orderColumnNames.includes('updated_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP');
  }
  if (!orderColumnNames.includes('paid_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN paid_at DATETIME');
  }
  if (!orderColumnNames.includes('cancelled_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN cancelled_at DATETIME');
  }
  if (!orderColumnNames.includes('idempotency_key')) {
    db.exec('ALTER TABLE orders ADD COLUMN idempotency_key TEXT');
  }

  const existingIndexes = db.prepare("PRAGMA index_list(orders)").all().map(i => i.name);
  if (!existingIndexes.includes('idx_orders_user_idempotency')) {
    try {
      db.exec('CREATE UNIQUE INDEX idx_orders_user_idempotency ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
    } catch (e) {
      console.log('Note: Partial unique index may not be supported, table-level constraint will handle it');
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      order_no TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      operation_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      idempotent_key TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status_expire ON orders(status, expire_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_stock_operations_order ON stock_operations(order_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_stock_operations_idempotent ON stock_operations(idempotent_key)');

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
    const stmt = db.prepare('INSERT INTO products (name, description, price, original_price, available_stock, sold_stock, category_id, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    products.forEach(p => stmt.run(p.name, p.description, p.price, p.original_price, p.stock, p.sales, p.category_id, p.image));
    console.log('✅ 示例商品已创建');
  }

  console.log('✅ 数据库初始化完成');
}

module.exports = { db, initDatabase, ORDER_TIMEOUT_MINUTES };
