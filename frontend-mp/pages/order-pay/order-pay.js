const app = getApp()

Page({
  data: {
    orderId: null,
    order: null,
    remainingSeconds: 0,
    minutes: '00',
    seconds: '00',
    isExpired: false,
    paying: false,
    timer: null,
    statusPollTimer: null
  },

  onLoad(options) {
    if (options.order_id) {
      this.setData({ orderId: options.order_id })
      this.loadOrder()
    }
  },

  onShow() {
    if (this.data.orderId) {
      this.loadOrder()
    }
  },

  onUnload() {
    this.clearTimers()
  },

  onHide() {
    this.clearTimers()
  },

  clearTimers() {
    if (this.data.timer) {
      clearInterval(this.data.timer)
    }
    if (this.data.statusPollTimer) {
      clearInterval(this.data.statusPollTimer)
    }
  },

  startCountdown() {
    this.clearTimers()
    
    const timer = setInterval(() => {
      let { remainingSeconds, order } = this.data
      
      if (remainingSeconds <= 0) {
        this.setData({ isExpired: true })
        clearInterval(timer)
        this.loadOrder()
        return
      }

      remainingSeconds--
      const mins = Math.floor(remainingSeconds / 60)
      const secs = remainingSeconds % 60

      this.setData({
        remainingSeconds,
        minutes: String(mins).padStart(2, '0'),
        seconds: String(secs).padStart(2, '0'),
        isExpired: remainingSeconds <= 0
      })

      if (remainingSeconds <= 0) {
        clearInterval(timer)
        setTimeout(() => this.loadOrder(), 500)
      }
    }, 1000)

    const statusPollTimer = setInterval(() => {
      if (this.data.order && this.data.order.status === 'pending') {
        this.checkPayStatus()
      }
    }, 5000)

    this.setData({ timer, statusPollTimer })
  },

  async loadOrder() {
    const { orderId } = this.data
    if (!orderId) return

    try {
      const order = await app.request({
        url: `/orders/${orderId}`
      })

      let remainingSeconds = order.remaining_pay_seconds || 0
      const isExpired = order.is_expired || order.status === 'timeout'
      
      if (order.status === 'cancelled' || order.status === 'timeout') {
        remainingSeconds = 0
      }

      const mins = Math.floor(remainingSeconds / 60)
      const secs = remainingSeconds % 60

      this.setData({
        order,
        remainingSeconds,
        minutes: String(mins).padStart(2, '0'),
        seconds: String(secs).padStart(2, '0'),
        isExpired
      })

      if (order.status === 'pending' && remainingSeconds > 0 && !this.data.timer) {
        this.startCountdown()
      }

      if (order.status === 'paid') {
        this.clearTimers()
      }
    } catch (err) {
      console.error('加载订单失败', err)
      wx.showToast({
        title: '订单加载失败',
        icon: 'none'
      })
    }
  },

  async checkPayStatus() {
    const { orderId } = this.data
    if (!orderId) return

    try {
      const status = await app.request({
        url: `/pay/status/${orderId}`
      })

      if (status.paid) {
        wx.showToast({ title: '支付成功', icon: 'success' })
        setTimeout(() => this.loadOrder(), 500)
      } else if (status.is_expired && !this.data.isExpired) {
        this.loadOrder()
      }
    } catch (err) {
      console.error('查询支付状态失败', err)
    }
  },

  async cancelOrder() {
    const { orderId, order } = this.data
    if (!orderId) return

    wx.showModal({
      title: '确认取消',
      content: '确定要取消该订单吗？库存将被释放。',
      success: async (res) => {
        if (res.confirm) {
          try {
            await app.request({
              url: `/orders/${orderId}/cancel`,
              method: 'PUT'
            })
            wx.showToast({ title: '订单已取消', icon: 'success' })
            setTimeout(() => this.loadOrder(), 800)
          } catch (err) {
            console.error('取消订单失败', err)
            wx.showToast({
              title: err.error || '取消失败',
              icon: 'none'
            })
          }
        }
      }
    })
  },

  async goToPay() {
    const { orderId, paying, order } = this.data
    if (paying || !orderId) return

    if (order && this.data.isExpired) {
      wx.showToast({ title: '订单已超时', icon: 'none' })
      return
    }

    this.setData({ paying: true })

    try {
      const payData = await app.request({
        url: '/pay/create',
        method: 'POST',
        data: { order_id: orderId }
      })

      if (payData.mock) {
        wx.showModal({
          title: '模拟支付',
          content: `剩余支付时间：${this.data.minutes}:${this.data.seconds}\n点击确定模拟支付成功`,
          success: async (res) => {
            if (res.confirm) {
              try {
                wx.showLoading({ title: '处理中...' })
                await app.request({
                  url: '/pay/mock-success',
                  method: 'POST',
                  data: { order_id: orderId }
                })
                wx.hideLoading()
                wx.showToast({ title: '支付成功', icon: 'success' })
                setTimeout(() => this.loadOrder(), 1000)
              } catch (err) {
                wx.hideLoading()
                console.error('模拟支付失败', err)
                wx.showToast({
                  title: err.error || '支付失败',
                  icon: 'none'
                })
              }
            }
            this.setData({ paying: false })
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
        success: () => {
          wx.showToast({ title: '支付成功', icon: 'success' })
          setTimeout(() => this.loadOrder(), 1000)
        },
        fail: (err) => {
          if (err.errMsg !== 'requestPayment:fail cancel') {
            wx.showToast({ title: '支付失败', icon: 'none' })
          }
        },
        complete: () => {
          this.setData({ paying: false })
        }
      })
    } catch (err) {
      console.error('发起支付失败', err)
      wx.showToast({
        title: err.error || '发起支付失败',
        icon: 'none'
      })
      this.setData({ paying: false })
    }
  },

  goBack() {
    wx.redirectTo({ url: '/pages/order-detail/order-detail' })
  },

  goToOrderList() {
    wx.redirectTo({ url: '/pages/order-detail/order-detail' })
  }
})
