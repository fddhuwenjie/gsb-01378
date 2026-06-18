var app = getApp()

Page({
  data: {
    categories: [],
    currentCategory: null,
    products: [],
    loading: false,
    page: 1,
    hasMore: true
  },

  onLoad: function() {
    this.loadCategories()
  },

  loadCategories: function() {
    var that = this
    app.request({ url: '/categories' }).then(function(categories) {
      that.setData({ 
        categories: categories,
        currentCategory: categories.length > 0 ? categories[0].id : null
      })
      if (categories.length > 0) {
        that.loadProducts()
      }
    }).catch(function(err) {
      console.error('加载分类失败', err)
    })
  },

  loadProducts: function() {
    if (this.data.loading || !this.data.currentCategory) return
    
    var that = this
    this.setData({ loading: true })
    
    app.request({
      url: '/products',
      data: { 
        category_id: this.data.currentCategory,
        page: this.data.page, 
        limit: 10 
      }
    }).then(function(res) {
      var list = res.list || []
      that.setData({
        products: that.data.products.concat(list),
        page: that.data.page + 1,
        hasMore: list.length === 10,
        loading: false
      })
    }).catch(function(err) {
      console.error('加载商品失败', err)
      that.setData({ loading: false })
    })
  },

  selectCategory: function(e) {
    var id = e.currentTarget.dataset.id
    if (id === this.data.currentCategory) return
    
    this.setData({
      currentCategory: id,
      products: [],
      page: 1,
      hasMore: true
    })
    this.loadProducts()
  },

  goProduct: function(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product/product?id=' + id })
  },

  loadMore: function() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadProducts()
    }
  },

  addToCart: function(e) {
    var that = this
    var item = e.currentTarget.dataset.item
    
    if (!app.globalData.token) {
      app.login().then(function() {
        that.addToCart(e)
      })
      return
    }

    app.request({
      url: '/cart',
      method: 'POST',
      data: {
        product_id: item.id,
        quantity: 1
      }
    }).then(function() {
      wx.showToast({ title: '已加入购物车', icon: 'success' })
      app.updateCartBadge()
    }).catch(function(err) {
      console.error('加入购物车失败', err)
    })
  }
})
