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

  // 倒计时定时器：每秒刷新一次 pending 订单的"剩余支付时间"
  // 注意：这里只重算前端展示，并不会去触发后端关单；服务端的 reaper + 被动过期是真正的事实源
  _countdownTimer: null,

  onLoad(options) {
    if (options.status) {
      this.setData({ currentStatus: options.status })
    }
    this.loadOrders()
  },

  onShow() {
    this.startCountdown()
  },

  onHide() {
    this.stopCountdown()
  },

  onUnload() {
    this.stopCountdown()
  },

  startCountdown() {
    var that = this
    this.stopCountdown()
    this._countdownTimer = setInterval(function () {
      var orders = that.data.orders
      var changed = false
      var nextOrders = orders.map(function (o) {
        if (o.status !== 'pending') return o
        var remaining = Math.max(0, (o.remaining_ms || 0) - 1000)
        if (remaining !== o.remaining_ms) changed = true
        return Object.assign({}, o, {
          remaining_ms: remaining,
          remaining_text: that.formatRemaining(remaining),
          pay_expired: remaining === 0,
        })
      })
      if (changed) that.setData({ orders: nextOrders })
    }, 1000)
  },

  stopCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer)
      this._countdownTimer = null
    }
  },

  formatRemaining(ms) {
    if (!ms || ms <= 0) return '已过期'
    var totalSec = Math.floor(ms / 1000)
    var min = Math.floor(totalSec / 60)
    var sec = totalSec % 60
    return min + '分' + (sec < 10 ? '0' : '') + sec + '秒'
  },

  decorateOrders(list) {
    var that = this
    return list.map(function (o) {
      return Object.assign({}, o, {
        remaining_text: that.formatRemaining(o.remaining_ms),
      })
    })
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
        orders: this.decorateOrders([...this.data.orders, ...res.list]),
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
      closed: '超时关闭'
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

    // 防止用户在已过期订单上仍然尝试支付
    var target = this.data.orders.find(function (o) { return o.id === id })
    if (target && target.pay_expired) {
      wx.showToast({ title: '订单已过期，请重新下单', icon: 'none' })
      this.setData({ orders: [], page: 1, hasMore: true })
      this.loadOrders()
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
                // 服务端会返回 ORDER_CLOSED / ORDER_EXPIRED 等明确错误码
                console.error('模拟支付失败', err)
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
    }
  }
})
