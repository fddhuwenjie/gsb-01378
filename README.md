# 微信小程序电商系统

一个完整的微信小程序电商系统，包含后端API、管理后台和小程序端。

## How to Run

```bash
# 启动所有服务
docker compose up -d

# 查看服务状态
docker compose ps

# 查看日志
docker compose logs -f
```

## Services

| 服务 | 地址 | 说明 |
|------|------|------|
| 后端API | http://localhost:3000 | Node.js + Express + SQLite |
| 管理后台 | http://localhost:8081 | React + Vite + Ant Design |
| 小程序 | 微信开发者工具打开 `frontend-mp` | 原生微信小程序 |

## 测试账号

**管理后台：**
- 用户名：`admin`
- 密码：`admin123`

**小程序：**
- 进入"我的"页面，点击头像区域登录

## 题目内容

微信小程序电商系统，实现商品浏览、购物车、订单管理等功能。

---

## 小程序配置

### 修改API地址

编辑 `frontend-mp/config.js`：

```javascript
const config = {
  dev: {
    baseUrl: 'http://127.0.0.1:3000/api',  // 本地开发
    // baseUrl: 'http://你的IP:3000/api',   // 局域网测试
  },
  prod: {
    baseUrl: 'https://你的域名/api',        // 生产环境
  }
}
```

### 开发者工具设置

1. 打开微信开发者工具
2. 导入 `frontend-mp` 目录
3. 在"详情" → "本地设置"中勾选"不校验合法域名"

---

## 后端配置

### 环境变量

复制 `.env.example` 为 `.env` 并修改：

```bash
cd backend
cp .env.example .env
```

可配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| PORT | 服务端口 | 3000 |
| NODE_ENV | 运行环境 | development |
| JWT_SECRET | JWT密钥 | (请修改) |
| JWT_EXPIRES_IN | Token有效期 | 7d |
| DB_PATH | 数据库路径 | ./data/shop.db |
| LOG_LEVEL | 日志级别 | info |

---

## 环境配置说明

### 开发/演示环境

开发环境使用模拟登录和模拟支付，无需配置微信相关参数，开箱即用。

```bash
# docker-compose.yml 中已默认配置
WECHAT_MOCK_LOGIN=true   # 模拟微信登录
WECHAT_MOCK_PAY=true     # 模拟微信支付
```

**模拟登录流程：**
1. 在小程序中进入"我的"页面
2. 点击头像区域触发登录
3. 显示"模拟登录成功"提示
4. 自动创建测试用户并登录

**模拟支付流程：**
1. 在小程序中下单后，进入"我的订单"
2. 点击待付款订单的"去支付"按钮
3. 弹出模拟支付确认框，点击"确定"即完成支付
4. 订单状态自动变为"待发货"

### 生产环境

生产环境需要配置真实的微信小程序和微信支付参数。

**1. 微信小程序配置**

在 [微信公众平台](https://mp.weixin.qq.com/) 获取：

```bash
WECHAT_MOCK_LOGIN=false
WECHAT_APP_ID=wx1234567890abcdef        # 小程序AppID
WECHAT_APP_SECRET=your_app_secret       # 小程序AppSecret
```

**2. 微信支付配置**

在 [微信支付商户平台](https://pay.weixin.qq.com/) 获取：

```bash
WECHAT_MOCK_PAY=false
WECHAT_MCH_ID=1234567890                # 商户号
WECHAT_API_KEY=your_api_v3_key          # API v3密钥
WECHAT_CERT_SERIAL_NO=CERT_SERIAL_NO    # 证书序列号
WECHAT_PRIVATE_KEY_PATH=./certs/apiclient_key.pem  # 私钥文件路径
WECHAT_PAY_NOTIFY_URL=https://your-domain.com/api/pay/notify  # 支付回调地址
```

**3. 证书配置**

将微信支付证书放置到 `backend/certs/` 目录：
- `apiclient_key.pem` - 商户私钥文件

**4. 完整生产环境配置示例**

```bash
# backend/.env
NODE_ENV=production
PORT=3000
JWT_SECRET=your-strong-secret-key-here

# 微信小程序
WECHAT_MOCK_LOGIN=false
WECHAT_APP_ID=wx1234567890abcdef
WECHAT_APP_SECRET=your_app_secret

# 微信支付
WECHAT_MOCK_PAY=false
WECHAT_MCH_ID=1234567890
WECHAT_API_KEY=your_api_v3_key
WECHAT_CERT_SERIAL_NO=CERT_SERIAL_NO
WECHAT_PRIVATE_KEY_PATH=./certs/apiclient_key.pem
WECHAT_PAY_NOTIFY_URL=https://your-domain.com/api/pay/notify
```

### 日志系统

日志文件位于 `backend/logs/` 目录：
- `error.log` - 错误日志
- `combined.log` - 综合日志

---

## 项目结构

```
├── backend/                 # 后端服务
│   ├── src/
│   │   ├── routes/         # API路由
│   │   ├── middleware/     # 中间件
│   │   ├── utils/          # 工具函数
│   │   ├── database.js     # 数据库
│   │   └── index.js        # 入口文件
│   ├── logs/               # 日志目录
│   ├── uploads/            # 上传文件
│   ├── .env.example        # 环境变量示例
│   └── Dockerfile
│
├── frontend-admin/          # 管理后台
│   ├── src/
│   │   ├── pages/          # 页面组件
│   │   ├── components/     # 通用组件
│   │   └── utils/          # 工具函数
│   └── Dockerfile
│
├── frontend-mp/             # 微信小程序
│   ├── pages/              # 页面
│   │   ├── index/          # 首页
│   │   ├── category/       # 分类
│   │   ├── cart/           # 购物车
│   │   ├── mine/           # 我的
│   │   ├── product/        # 商品详情
│   │   ├── search/         # 搜索
│   │   ├── order/          # 订单确认
│   │   └── order-detail/   # 订单详情
│   ├── images/             # 图片资源
│   ├── config.js           # 配置文件
│   ├── app.js              # 应用入口
│   └── app.json            # 应用配置
│
├── docker-compose.yml       # Docker编排
└── README.md
```

---

## API接口

### 公开接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查 |
| GET | /api/products | 商品列表 |
| GET | /api/products/:id | 商品详情 |
| GET | /api/categories | 分类列表 |
| POST | /api/auth/mp-login | 小程序登录 |
| POST | /api/auth/login | 管理员登录 |

### 需要登录

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/cart | 购物车列表 |
| POST | /api/cart | 添加购物车 |
| PUT | /api/cart/:id | 修改数量 |
| DELETE | /api/cart/:id | 删除商品 |
| GET | /api/orders | 订单列表 |
| POST | /api/orders | 创建订单 |
| GET | /api/addresses | 收货地址列表 |
| POST | /api/addresses | 添加地址 |
| PUT | /api/addresses/:id | 更新地址 |
| DELETE | /api/addresses/:id | 删除地址 |
| POST | /api/pay/create | 创建支付订单 |
| POST | /api/pay/mock-success | 模拟支付成功（仅开发环境） |
| GET | /api/pay/status/:orderId | 查询支付状态 |

### 管理员接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/products | 创建商品 |
| PUT | /api/products/:id | 更新商品 |
| DELETE | /api/products/:id | 删除商品 |
| PUT | /api/orders/:id/status | 更新订单状态 |

---

## 功能特性

### 小程序端
- ✅ 商品浏览与搜索
- ✅ 分类筛选
- ✅ 购物车管理
- ✅ 订单创建与查看
- ✅ 购物车角标实时更新
- ✅ 收货地址管理
- ✅ 微信支付（开发环境模拟/生产环境真实支付）

### 管理后台
- ✅ 商品管理（增删改查）
- ✅ 分类管理
- ✅ 订单管理
- ✅ 数据统计面板

### 后端服务
- ✅ RESTful API
- ✅ JWT认证
- ✅ 日志记录
- ✅ 环境变量配置
- ✅ 健康检查
- ✅ 数据库事务支持

### 功能说明
- 开发环境使用模拟登录和模拟支付，无需配置即可体验完整流程
- 生产环境需配置微信小程序 AppID/AppSecret 和微信支付商户信息

---

## 技术栈

- **后端**：Node.js + Express + SQLite + Winston
- **管理后台**：React + Vite + Ant Design
- **小程序**：微信原生开发
- **部署**：Docker + Docker Compose

---

## 开发建议

### 生产环境优化

1. **数据库**：考虑使用 MySQL/PostgreSQL 替代 SQLite
2. **缓存**：添加 Redis 缓存热点数据
3. **安全**：
   - 修改默认 JWT 密钥
   - 启用 HTTPS
   - 添加接口限流
4. **监控**：接入 APM 监控系统

### 本地开发

```bash
# 后端开发模式
cd backend
npm install
npm run dev

# 管理后台开发模式
cd frontend-admin
npm install
npm run dev
```
