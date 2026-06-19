const app = getApp()

Page({
  data: {
    items: [],
    selectedAddress: null,
    addresses: [],
    showAddressPicker: false,
    remark: '',
    totalAmount: 0,
    submitting: false
  },

  onLoad(options) {
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
    // 从地址页返回时刷新地址列表
    this.loadAddresses()
  },

  loadAddresses() {
    const that = this
    app.request({ url: '/addresses' }).then(function(res) {
      const addresses = res || []
      that.setData({ addresses })
      // 自动选择默认地址
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
    const { items, selectedAddress, remark, submitting } = this.data
    
    if (submitting) return
    
    if (!selectedAddress) {
      wx.showToast({ title: '请选择收货地址', icon: 'none' })
      return
    }

    this.setData({ submitting: true })

    // 幂等键：每个"提交动作"生成一个稳定的 key。
    //   - 连续点击/网络抖动重试时，后端会识别同一个 key 直接返回上次创建的订单，
    //     不会重复扣库存/重复占用预占库存。
    //   - 用户按返回键再进来重新填写、再提交，会产生新的 key（新订单）。
    if (!this._idempotencyKey) {
      this._idempotencyKey =
        'mp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10)
    }
    const idempotencyKey = this._idempotencyKey

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
          idempotency_key: idempotencyKey
        }
      })

      wx.showToast({
        title: res.idempotent ? '订单已存在' : '下单成功',
        icon: 'success'
      })

      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/order-detail/order-detail`
        })
      }, 1500)
    } catch (err) {
      console.error('提交订单失败', err)
      // 失败时清掉幂等键，让用户下次提交是新的请求
      this._idempotencyKey = null
    } finally {
      this.setData({ submitting: false })
    }
  }
})
