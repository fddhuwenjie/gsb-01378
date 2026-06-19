const app = getApp()

Page({
  data: {
    order: null,
    loading: true,
    countdownTimer: null,
    statusTextMap: {
      pending: '待付款',
      paid: '待发货',
      shipped: '待收货',
      completed: '已完成',
      cancelled: '已取消',
      timeout: '已超时'
    }
  },

  onLoad(options) {
    if (options.id) {
      this.orderId = parseInt(options.id)
      this.loadOrderDetail()
    }
  },

  onUnload() {
    if (this.data.countdownTimer) {
      clearInterval(this.data.countdownTimer)
    }
  },

  onShow() {
    if (this.orderId) {
      this.loadOrderDetail()
    }
  },

  onPullDownRefresh() {
    this.loadOrderDetail().finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  startCountdown() {
    if (this.data.countdownTimer) {
      clearInterval(this.data.countdownTimer)
    }
    const timer = setInterval(() => {
      this.updateCountdown()
    }, 1000)
    this.setData({ countdownTimer: timer })
  },

  updateCountdown() {
    const order = this.data.order
    if (!order || order.status !== 'pending') return

    if (order.pay_expire_remaining > 0) {
      const remaining = Math.max(0, order.pay_expire_remaining - 1)
      const mins = Math.floor(remaining / 60)
      const secs = remaining % 60
      this.setData({
        'order.pay_expire_remaining': remaining,
        'order.pay_expired': remaining <= 0,
        'order.countdown_text': `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
      })

      if (remaining <= 0) {
        this.handleOrderExpired()
      }
    }
  },

  async handleOrderExpired() {
    try {
      await app.request({
        url: `/pay/status/${this.orderId}`
      })
      this.loadOrderDetail()
    } catch (err) {
      console.error('刷新超时状态失败', err)
    }
  },

  async loadOrderDetail() {
    if (!this.orderId) return

    this.setData({ loading: true })
    try {
      const order = await app.request({
        url: `/orders/${this.orderId}`
      })

      if (order.status === 'pending') {
        const remaining = order.pay_expire_remaining || 0
        const mins = Math.floor(remaining / 60)
        const secs = remaining % 60
        order.countdown_text = remaining > 0 
          ? `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
          : '已超时'
        order.pay_expired = remaining <= 0
        this.startCountdown()
      }

      this.setData({ order })
    } catch (err) {
      console.error('加载订单详情失败', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async cancelOrder() {
    wx.showModal({
      title: '提示',
      content: '确定取消该订单吗？库存将立即释放',
      success: async (res) => {
        if (res.confirm) {
          try {
            wx.showLoading({ title: '处理中...' })
            await app.request({
              url: `/orders/${this.orderId}/cancel`,
              method: 'PUT'
            })
            wx.hideLoading()
            wx.showToast({ title: '已取消', icon: 'success' })
            this.loadOrderDetail()
          } catch (err) {
            wx.hideLoading()
            wx.showToast({ title: err.error || '取消失败', icon: 'none' })
          }
        }
      }
    })
  },

  async goToPay() {
    const that = this
    try {
      wx.showLoading({ title: '正在发起支付...' })
      
      const payData = await app.request({
        url: '/pay/create',
        method: 'POST',
        data: { order_id: this.orderId }
      })

      wx.hideLoading()

      if (payData.already_paid) {
        wx.showToast({ title: '订单已支付', icon: 'success' })
        that.loadOrderDetail()
        return
      }

      if (payData.order_status === 'timeout' || payData.order_status === 'cancelled') {
        wx.showToast({ title: '订单已关闭，请重新下单', icon: 'none' })
        that.loadOrderDetail()
        return
      }

      if (payData.mock) {
        wx.showModal({
          title: '模拟支付',
          content: `请在 ${Math.floor(payData.pay_expire_remaining / 60)} 分钟内完成支付，点击确定模拟支付成功`,
          success: async (res) => {
            if (res.confirm) {
              try {
                wx.showLoading({ title: '处理中...' })
                await app.request({
                  url: '/pay/mock-success',
                  method: 'POST',
                  data: { order_id: that.orderId }
                })
                wx.hideLoading()
                wx.showToast({ title: '支付成功', icon: 'success' })
                that.loadOrderDetail()
              } catch (err) {
                wx.hideLoading()
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
          that.loadOrderDetail()
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
  },

  goBack() {
    wx.navigateBack()
  },

  goToHome() {
    wx.switchTab({ url: '/pages/index/index' })
  }
})
