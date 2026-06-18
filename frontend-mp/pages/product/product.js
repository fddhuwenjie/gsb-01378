var app = getApp()

Page({
  data: {
    product: null,
    quantity: 1,
    loading: true,
    showQtyModal: false,
    buyMode: 'cart' // cart 或 buy
  },

  onLoad: function(options) {
    var id = options.id
    if (id) {
      this.loadProduct(id)
    }
  },

  loadProduct: function(id) {
    var that = this
    this.setData({ loading: true })
    
    app.request({ url: '/products/' + id }).then(function(product) {
      that.setData({ product: product, loading: false })
    }).catch(function(err) {
      console.error('加载商品失败', err)
      that.setData({ loading: false })
      wx.showToast({ title: '商品不存在', icon: 'none' })
      setTimeout(function() {
        wx.navigateBack()
      }, 1500)
    })
  },

  minus: function() {
    if (this.data.quantity > 1) {
      this.setData({ quantity: this.data.quantity - 1 })
    }
  },

  plus: function() {
    if (this.data.quantity < this.data.product.stock) {
      this.setData({ quantity: this.data.quantity + 1 })
    }
  },

  addToCart: function() {
    var that = this
    
    if (!app.globalData.token) {
      app.login().then(function() {
        that.addToCart()
      })
      return
    }

    this.setData({ showQtyModal: true, buyMode: 'cart', quantity: 1 })
  },

  buyNow: function() {
    var that = this
    
    if (!app.globalData.token) {
      app.login().then(function() {
        that.buyNow()
      })
      return
    }

    this.setData({ showQtyModal: true, buyMode: 'buy', quantity: 1 })
  },

  closeQtyModal: function() {
    this.setData({ showQtyModal: false })
  },

  confirmAction: function() {
    var that = this
    
    if (this.data.buyMode === 'cart') {
      app.request({
        url: '/cart',
        method: 'POST',
        data: {
          product_id: this.data.product.id,
          quantity: this.data.quantity
        }
      }).then(function() {
        that.setData({ showQtyModal: false })
        wx.showToast({ title: '已加入购物车', icon: 'success' })
        app.updateCartBadge()
      })
    } else {
      var product = this.data.product
      var item = {
        product_id: product.id,
        name: product.name,
        image: product.image,
        price: product.price,
        quantity: this.data.quantity
      }
      this.setData({ showQtyModal: false })
      wx.navigateTo({
        url: '/pages/order/order?items=' + encodeURIComponent(JSON.stringify([item]))
      })
    }
  },

  goHome: function() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  goCart: function() {
    wx.switchTab({ url: '/pages/cart/cart' })
  },

  previewImage: function() {
    var product = this.data.product
    if (product && product.image) {
      wx.previewImage({
        current: product.image,
        urls: [product.image]
      })
    }
  }
})
