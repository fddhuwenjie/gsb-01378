const app = getApp()

function formatTime(seconds) {
  if (!seconds || seconds <= 0) return ''
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

Page({
  data: {
    orders: [],
    loading: true,
    page: 1,
    hasMore: true,
    currentStatus: '',
    timer: null,
    countdowns: {},
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
    this.startCountdownTimer()
  },

  onShow() {
    this.setData({ page: 1, hasMore: true, orders: [], countdowns: {} })
    this.loadOrders()
  },

  onUnload() {
    if (this.data.timer) {
      clearInterval(this.data.timer)
    }
  },

  onPullDownRefresh() {
    this.setData({ page: 1, hasMore: true, orders: [], countdowns: {} })
    this.loadOrders().finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadOrders()
    }
  },

  startCountdownTimer() {
    if (this.data.timer) {
      clearInterval(this.data.timer)
    }
    const timer = setInterval(() => {
      const countdowns = { ...this.data.countdowns }
      let changed = false
      
      Object.keys(countdowns).forEach(orderId => {
        if (countdowns[orderId] > 0) {
          countdowns[orderId]--
          changed = true
        }
      })

      if (changed) {
        this.setData({ countdowns })
      }
    }, 1000)

    this.setData({ timer })
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
      
      const countdowns = { ...this.data.countdowns }
      const processedList = res.list.map(order => {
        if (order.status === 'pending' && order.remaining_pay_seconds > 0) {
          countdowns[order.id] = order.remaining_pay_seconds
        }
        return {
          ...order,
          statusText: this.getStatusText(order.status),
          countdownText: formatTime(order.remaining_pay_seconds)
        }
      })
      
      this.setData({
        orders: this.data.page === 1 ? processedList : [...this.data.orders, ...processedList],
        page: this.data.page + 1,
        hasMore: res.list.length === 10,
        countdowns
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
      hasMore: true,
      countdowns: {}
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

  goToOrderDetail(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({
      url: `/pages/order-pay/order-pay?order_id=${id}`
    })
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
            this.setData({ orders: [], page: 1, hasMore: true, countdowns: {} })
            this.loadOrders()
          } catch (err) {
            console.error('取消订单失败', err)
            wx.showToast({ title: err.error || '取消失败', icon: 'none' })
          }
        }
      }
    })
  },

  async goToPay(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({
      url: `/pages/order-pay/order-pay?order_id=${id}`
    })
  }
})
