var app = getApp()

Page({
  data: {
    banners: [
      { image: 'https://cdn.dummyjson.com/product-images/laptops/apple-macbook-pro-14-inch-space-grey/1.webp' },
      { image: 'https://cdn.dummyjson.com/product-images/smartphones/samsung-galaxy-s7/1.webp' },
      { image: 'https://cdn.dummyjson.com/product-images/furniture/annibale-colombo-sofa/1.webp' }
    ],
    categories: [],
    products: [],
    loading: false,
    page: 1,
    hasMore: true
  },

  onLoad: function() {
    this.loadCategories()
    this.loadProducts()
  },

  onShow: function() {
    app.updateCartBadge()
  },

  onPullDownRefresh: function() {
    var that = this
    this.setData({ page: 1, hasMore: true, products: [] })
    Promise.all([this.loadCategories(), this.loadProducts()]).then(function() {
      wx.stopPullDownRefresh()
    })
  },

  loadCategories: function() {
    var that = this
    return app.request({ url: '/categories' }).then(function(res) {
      that.setData({ categories: res })
    })
  },

  loadProducts: function() {
    if (this.data.loading) return Promise.resolve()
    var that = this
    this.setData({ loading: true })
    return app.request({
      url: '/products',
      data: { page: this.data.page, limit: 10 }
    }).then(function(res) {
      var list = res.list || []
      that.setData({
        products: that.data.products.concat(list),
        page: that.data.page + 1,
        hasMore: list.length >= 10,
        loading: false
      })
    }).catch(function() {
      that.setData({ loading: false })
    })
  },

  onReachBottom: function() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadProducts()
    }
  },

  goSearch: function() {
    wx.navigateTo({ url: '/pages/search/search' })
  },

  goCategory: function() {
    wx.switchTab({ url: '/pages/category/category' })
  },

  goProduct: function(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product/product?id=' + id })
  },

  addCart: function(e) {
    var id = e.currentTarget.dataset.id
    if (!app.globalData.token) {
      app.login()
      return
    }
    app.request({
      url: '/cart',
      method: 'POST',
      data: { product_id: id, quantity: 1 }
    }).then(function() {
      wx.showToast({ title: '已加入购物车', icon: 'success' })
      app.updateCartBadge()
    })
  }
})
