var app = getApp()

Page({
  data: {
    userInfo: null
  },

  onShow: function() {
    this.checkLogin()
  },

  checkLogin: function() {
    var userInfo = app.globalData.userInfo
    this.setData({ userInfo: userInfo || null })
  },

  login: function() {
    var that = this
    app.login().then(function(data) {
      that.checkLogin()
      // 模拟登录时 app.js 已经提示了，这里不重复提示
      if (!data.mock) {
        wx.showToast({ title: '登录成功', icon: 'success' })
      }
    }).catch(function(err) {
      console.error('登录失败', err)
    })
  },

  goOrders: function(e) {
    var status = e.currentTarget.dataset.status || ''
    wx.navigateTo({ url: '/pages/order-detail/order-detail?status=' + status })
  },

  goAddress: function() {
    if (!app.globalData.token) {
      this.login()
      return
    }
    wx.navigateTo({ url: '/pages/address/address' })
  },

  logout: function() {
    var that = this
    wx.showModal({
      title: '提示',
      content: '确定退出登录吗？',
      success: function(res) {
        if (res.confirm) {
          app.globalData.token = null
          app.globalData.userInfo = null
          wx.removeStorageSync('token')
          wx.removeStorageSync('userInfo')
          that.setData({ userInfo: null })
          wx.showToast({ title: '已退出登录', icon: 'success' })
        }
      }
    })
  },

  showTip: function(e) {
    var msg = e.currentTarget.dataset.msg || '功能开发中'
    wx.showToast({ title: msg, icon: 'none' })
  }
})
