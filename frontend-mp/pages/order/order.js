const app = getApp()

function generateIdempotentKey() {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 10)
  return `order_${timestamp}_${random}`
}

Page({
  data: {
    items: [],
    selectedAddress: null,
    addresses: [],
    showAddressPicker: false,
    remark: '',
    totalAmount: 0,
    submitting: false,
    idempotentKey: ''
  },

  onLoad(options) {
    this.setData({ idempotentKey: generateIdempotentKey() })
    
    if (options.items) {
      try {
        const items = JSON.parse(decodeURIComponent(options.items))
        const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0)
        this.setData({ items, totalAmount: totalAmount.toFixed(2) })
      } catch (err) {
        console.error('解析商品数据失败', err)
        wx.navigateBack()
      }
    }
    this.loadAddresses()
  },

  onShow() {
    this.loadAddresses()
  },

  loadAddresses() {
    const that = this
    app.request({ url: '/addresses' }).then(function(res) {
      const addresses = res || []
      that.setData({ addresses })
      if (!that.data.selectedAddress && addresses.length > 0) {
        const defaultAddr = addresses.find(a => a.is_default) || addresses[0]
        that.setData({ selectedAddress: defaultAddr })
      }
    }).catch(function(err) {
      console.error('加载地址失败', err)
    })
  },

  chooseAddress() {
    this.setData({ showAddressPicker: true })
  },

  closeAddressPicker() {
    this.setData({ showAddressPicker: false })
  },

  selectAddress(e) {
    const item = e.currentTarget.dataset.item
    this.setData({ selectedAddress: item, showAddressPicker: false })
  },

  goAddAddress() {
    this.setData({ showAddressPicker: false })
    wx.navigateTo({ url: '/pages/address/address' })
  },

  onInput(e) {
    const { field } = e.currentTarget.dataset
    this.setData({ [field]: e.detail.value })
  },

  async submitOrder() {
    const { items, selectedAddress, remark, submitting, idempotentKey } = this.data
    
    if (submitting) return
    
    if (!selectedAddress) {
      wx.showToast({ title: '请选择收货地址', icon: 'none' })
      return
    }

    this.setData({ submitting: true })

    try {
      const orderItems = items.map(item => ({
        product_id: item.product_id,
        quantity: item.quantity
      }))

      const res = await app.request({
        url: '/orders',
        method: 'POST',
        data: {
          items: orderItems,
          address: selectedAddress.region + ' ' + selectedAddress.detail,
          receiver_name: selectedAddress.name,
          receiver_phone: selectedAddress.phone,
          remark,
          idempotent_key: idempotentKey
        }
      })

      wx.showToast({
        title: '下单成功',
        icon: 'success',
        duration: 1000
      })

      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/order-pay/order-pay?order_id=${res.order_id}`
        })
      }, 1000)
    } catch (err) {
      console.error('提交订单失败', err)
      wx.showToast({
        title: err.error || '下单失败',
        icon: 'none'
      })
      this.setData({ submitting: false })
    }
  }
})
