const app = getApp()

Page({
  data: {
    orders: [],
    loading: true,
    page: 1,
    hasMore: true,
    currentStatus: '',
    countdownTimers: {},
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
    this.startCountdownRefresh()
  },

  onUnload() {
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval)
    }
  },

  onShow() {
    this.refreshCountdowns()
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

  startCountdownRefresh() {
    this._countdownInterval = setInterval(() => {
      this.refreshCountdowns()
    }, 1000)
  },

  refreshCountdowns() {
    const orders = this.data.orders
    const now = Date.now()
    let hasUpdate = false

    const updatedOrders = orders.map(order => {
      if (order.status !== 'pending' || !order.expire_at) {
        return order
      }

      const expireTime = new Date(order.expire_at).getTime()
      const remainingMs = expireTime - now

      if (remainingMs <= 0) {
        if (!order.is_expired) {
          hasUpdate = true
          return { ...order, is_expired: true, countdown_text: '已过期' }
        }
        return order
      }

      const remainingSeconds = Math.floor(remainingMs / 1000)
      const minutes = Math.floor(remainingSeconds / 60)
      const seconds = remainingSeconds % 60
      const countdownText = `${minutes}分${seconds.toString().padStart(2, '0')}秒`

      if (order.countdown_text !== countdownText) {
        hasUpdate = true
        return { ...order, countdown_text: countdownText, is_expired: false }
      }
      return order
    })

    if (hasUpdate) {
      this.setData({ orders: updatedOrders })
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
      
      const ordersWithCountdown = res.list.map(order => {
        if (order.status === 'pending' && order.time_remaining) {
          return {
            ...order,
            countdown_text: order.time_remaining.formatted,
            is_expired: order.time_remaining.expired
          }
        }
        return order
      })

      this.setData({
        orders: [...this.data.orders, ...ordersWithCountdown],
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
      cancelled: '已取消',
      timeout: '已超时'
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

    const order = this.data.orders.find(o => o.id === id)
    if (order && order.is_expired) {
      wx.showModal({
        title: '订单已过期',
        content: '该订单已超时关闭，请重新下单',
        showCancel: false
      })
      return
    }

    try {
      wx.showLoading({ title: '正在发起支付...' })
      
      const payData = await app.request({
        url: '/pay/create',
        method: 'POST',
        data: { order_id: id }
      })

      wx.hideLoading()

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
                wx.showToast({ title: err.error || '支付失败', icon: 'none' })
              }
            }
          }
        })
        return
      }

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
      wx.showToast({ title: err.error || '发起支付失败', icon: 'none' })
    }
  }
})
