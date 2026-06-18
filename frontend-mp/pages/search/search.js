var app = getApp()

Page({
  data: {
    keyword: '',
    history: [],
    hotWords: ['手机', '笔记本', '衬衫', '连衣裙', '牛排', '沙发'],
    products: [],
    total: 0,
    page: 1,
    hasMore: true,
    loading: false,
    searched: false
  },

  onLoad: function() {
    var history = wx.getStorageSync('searchHistory') || []
    this.setData({ history: history })
  },

  onInput: function(e) {
    this.setData({ keyword: e.detail.value })
  },

  clearKeyword: function() {
    this.setData({ keyword: '', searched: false, products: [] })
  },

  searchByTag: function(e) {
    var keyword = e.currentTarget.dataset.keyword
    this.setData({ keyword: keyword })
    this.doSearch()
  },

  doSearch: function() {
    var keyword = this.data.keyword.trim()
    if (!keyword) return
    
    // 保存搜索历史
    var history = this.data.history.filter(function(item) { return item !== keyword })
    history.unshift(keyword)
    if (history.length > 10) history = history.slice(0, 10)
    this.setData({ history: history })
    wx.setStorageSync('searchHistory', history)
    
    // 重置搜索
    this.setData({ products: [], page: 1, hasMore: true, searched: true })
    this.loadProducts()
  },

  loadProducts: function() {
    if (this.data.loading || !this.data.hasMore) return
    
    var that = this
    this.setData({ loading: true })
    
    app.request({
      url: '/products',
      data: { keyword: this.data.keyword, page: this.data.page, limit: 10 }
    }).then(function(res) {
      var list = res.list || []
      that.setData({
        products: that.data.products.concat(list),
        total: res.total || list.length,
        page: that.data.page + 1,
        hasMore: list.length >= 10,
        loading: false
      })
    }).catch(function() {
      that.setData({ loading: false })
    })
  },

  onReachBottom: function() {
    if (this.data.searched) {
      this.loadProducts()
    }
  },

  clearHistory: function() {
    this.setData({ history: [] })
    wx.removeStorageSync('searchHistory')
  },

  goBack: function() {
    wx.navigateBack()
  },

  goProduct: function(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product/product?id=' + id })
  }
})
