var config = require('./config.js')

App({
  globalData: {
    userInfo: null,
    token: null,
    cartCount: 0,
    baseUrl: config.baseUrl
  },
  
  onLaunch: function() {
    console.log('[App] 启动, 环境:', config.ENV, ', API:', config.baseUrl)
    
    // 从缓存读取登录状态
    var token = wx.getStorageSync('token')
    var userInfo = wx.getStorageSync('userInfo')
    
    if (token) {
      this.globalData.token = token
      this.globalData.userInfo = userInfo
      this.updateCartBadge()
    }
  },

  // 更新购物车角标
  updateCartBadge: function() {
    var that = this
    if (!this.globalData.token) {
      wx.removeTabBarBadge({ index: 2 })
      this.globalData.cartCount = 0
      return
    }
    
    this.request({ url: '/cart' }).then(function(res) {
      var items = res.items || []
      var count = items.reduce(function(sum, item) {
        return sum + item.quantity
      }, 0)
      
      that.globalData.cartCount = count
      
      if (count > 0) {
        wx.setTabBarBadge({
          index: 2,
          text: count > 99 ? '99+' : String(count)
        })
      } else {
        wx.removeTabBarBadge({ index: 2 })
      }
    }).catch(function() {
      wx.removeTabBarBadge({ index: 2 })
    })
  },

  // 封装请求方法
  request: function(options) {
    var that = this
    return new Promise(function(resolve, reject) {
      var header = {
        'Content-Type': 'application/json'
      }
      
      if (that.globalData.token) {
        header['Authorization'] = 'Bearer ' + that.globalData.token
      }

      var url = that.globalData.baseUrl + options.url
      console.log('[Request]', options.method || 'GET', url)

      wx.request({
        url: url,
        method: options.method || 'GET',
        data: options.data,
        header: header,
        success: function(res) {
          console.log('[Response]', res.statusCode)
          if (res.statusCode === 200) {
            resolve(res.data)
          } else if (res.statusCode === 401) {
            that.globalData.token = null
            that.globalData.userInfo = null
            wx.removeStorageSync('token')
            wx.removeStorageSync('userInfo')
            wx.showToast({ title: '请先登录', icon: 'none' })
            reject(res.data)
          } else {
            wx.showToast({ title: res.data.error || '请求失败', icon: 'none' })
            reject(res.data)
          }
        },
        fail: function(err) {
          console.error('[Request Error]', err)
          wx.showToast({ title: '网络错误', icon: 'none' })
          reject(err)
        }
      })
    })
  },

  // 登录
  login: function() {
    var that = this
    return new Promise(function(resolve, reject) {
      wx.login({
        success: function(res) {
          if (res.code) {
            that.request({
              url: '/auth/mp-login',
              method: 'POST',
              data: { code: res.code }
            }).then(function(data) {
              that.globalData.token = data.token
              that.globalData.userInfo = data.user
              wx.setStorageSync('token', data.token)
              wx.setStorageSync('userInfo', data.user)
              that.updateCartBadge()
              
              // 模拟登录提示
              if (data.mock) {
                wx.showToast({ 
                  title: '模拟登录成功', 
                  icon: 'none',
                  duration: 2000
                })
              }
              
              resolve(data)
            }).catch(reject)
          } else {
            reject(new Error('登录失败'))
          }
        },
        fail: reject
      })
    })
  }
})
