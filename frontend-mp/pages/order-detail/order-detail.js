const app = getApp()

Page({
  data: {
    orders: [],
    loading: true,
    page: 1,
    hasMore: true,
    currentStatus: '',
    statusTabs: [
      { value: '', label: '全部' },
      { value: 'pending', label: '待付款' },
      { value: 'paid', label: '待发货' },
      { value: 'shipped', label: '待收货' },
      { value: 'completed', label: '已完成' }
    ]
  },

  onLoad(options) {
    if (options.status) {
      this.setData({ currentStatus: options.status })
    }
    this.loadOrders()
  },

  onPullDownRefresh() {
    this.setData({ page: 1, hasMore: true, orders: [] })
    this.loadOrders().finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadOrders()
    }
  },

  async loadOrders() {
    if (this.data.loading && this.data.page > 1) return
    
    this.setData({ loading: true })
    
    try {
      const params = { page: this.data.page, limit: 10 }
      if (this.data.currentStatus) {
        params.status = this.data.currentStatus
      }
      
      const res = await app.request({
        url: '/orders',
        data: params
      })
      
      this.setData({
        orders: [...this.data.orders, ...res.list],
        page: this.data.page + 1,
        hasMore: res.list.length === 10
      })
    } catch (err) {
      console.error('加载订单失败', err)
    } finally {
      this.setData({ loading: false })
    }
  },

  switchTab(e) {
    const { status } = e.currentTarget.dataset
    if (status === this.data.currentStatus) return
    
    this.setData({
      currentStatus: status,
      orders: [],
      page: 1,
      hasMore: true
    })
    this.loadOrders()
  },

  getStatusText(status) {
    const map = {
      pending: '待付款',
      paid: '待发货',
      shipped: '待收货',
      completed: '已完成',
      cancelled: '已取消'
    }
    return map[status] || status
  },

  async cancelOrder(e) {
    const { id } = e.currentTarget.dataset
    
    wx.showModal({
      title: '提示',
      content: '确定取消该订单吗？',
      success: async (res) => {
        if (res.confirm) {
          try {
            await app.request({
              url: `/orders/${id}/cancel`,
              method: 'PUT'
            })
            wx.showToast({ title: '已取消', icon: 'success' })
            this.setData({ orders: [], page: 1, hasMore: true })
            this.loadOrders()
          } catch (err) {
            console.error('取消订单失败', err)
          }
        }
      }
    })
  },

  async goToPay(e) {
    const { id } = e.currentTarget.dataset
    const that = this

    try {
      wx.showLoading({ title: '正在发起支付...' })
      
      // 创建支付订单
      const payData = await app.request({
        url: '/pay/create',
        method: 'POST',
        data: { order_id: id }
      })

      wx.hideLoading()

      // 模拟支付环境
      if (payData.mock) {
        wx.showModal({
          title: '模拟支付',
          content: '当前为开发环境，点击确定模拟支付成功',
          success: async (res) => {
            if (res.confirm) {
              try {
                await app.request({
                  url: '/pay/mock-success',
                  method: 'POST',
                  data: { order_id: id }
                })
                wx.showToast({ title: '支付成功', icon: 'success' })
                that.setData({ orders: [], page: 1, hasMore: true })
                that.loadOrders()
              } catch (err) {
                console.error('模拟支付失败', err)
              }
            }
          }
        })
        return
      }

      // 真实微信支付
      wx.requestPayment({
        timeStamp: payData.timeStamp,
        nonceStr: payData.nonceStr,
        package: payData.package,
        signType: payData.signType,
        paySign: payData.paySign,
        success: function() {
          wx.showToast({ title: '支付成功', icon: 'success' })
          that.setData({ orders: [], page: 1, hasMore: true })
          that.loadOrders()
        },
        fail: function(err) {
          if (err.errMsg !== 'requestPayment:fail cancel') {
            wx.showToast({ title: '支付失败', icon: 'none' })
          }
        }
      })

    } catch (err) {
      wx.hideLoading()
      console.error('发起支付失败', err)
      wx.showToast({ title: '发起支付失败', icon: 'none' })
    }
  }
})
