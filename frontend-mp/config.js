/**
 * 小程序配置文件
 * 根据不同环境修改对应配置
 */

// 环境配置
const ENV = 'dev' // 可选: dev, prod

const config = {
  // 开发环境
  dev: {
    baseUrl: 'http://127.0.0.1:3000/api',  // 本地开发
    // baseUrl: 'http://192.168.31.141:3000/api',  // 局域网测试（替换为你的IP）
  },
  // 生产环境
  prod: {
    baseUrl: 'https://your-domain.com/api',  // 替换为你的线上域名
  }
}

module.exports = {
  ...config[ENV],
  ENV
}
