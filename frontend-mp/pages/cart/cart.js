var app = getApp()

Page({
  data: {
    cartItems: [],
    selectedCount: 0,
    isAllSelected: false,
    loading: true,
    totalAmount: 0
  },

  onShow: function() {
    if (app.globalData.token) {
      this.loadCart()
    } else {
      this.setData({ loading: false, cartItems: [] })
    }
  },

  loadCart: function() {
    var that = this
    this.setData({ loading: true })
    
    app.request({ url: '/cart' }).then(function(res) {
      var items = (res.items || []).filter(function(item) {
        return item.status === 1
      }).map(function(item) {
        item.selected = true
        return item
      })
      
      that.setData({ 
        cartItems: items,
        loading: false
      })
      that.calcTotal()
    }).catch(function(err) {
      console.error('加载购物车失败', err)
      that.setData({ loading: false })
    })
  },

  toggleItem: function(e) {
    var id = e.currentTarget.dataset.id
    var cartItems = this.data.cartItems.map(function(item) {
      if (item.id === id) {
        item.selected = !item.selected
      }
      return item
    })
    this.setData({ cartItems: cartItems })
    this.calcTotal()
  },

  toggleAll: function() {
    var isAllSelected = !this.data.isAllSelected
    var cartItems = this.data.cartItems.map(function(item) {
      item.selected = isAllSelected
      return item
    })
    this.setData({ cartItems: cartItems })
    this.calcTotal()
  },

  calcTotal: function() {
    var cartItems = this.data.cartItems
    var selected = cartItems.filter(function(item) {
      return item.selected
    })
    
    var total = selected.reduce(function(sum, item) {
      return sum + item.price * item.quantity
    }, 0)
    
    this.setData({
      totalAmount: total.toFixed(2),
      selectedCount: selected.length,
      isAllSelected: selected.length === cartItems.length && cartItems.length > 0
    })
  },

  changeQty: function(e) {
    var that = this
    var id = e.currentTarget.dataset.id
    var type = e.currentTarget.dataset.type
    var item = this.data.cartItems.find(function(i) { return i.id === id })
    if (!item) return

    var quantity = item.quantity
    if (type === 'minus' && quantity > 1) {
      quantity--
    } else if (type === 'plus' && quantity < item.stock) {
      quantity++
    } else {
      return
    }

    app.request({
      url: '/cart/' + id,
      method: 'PUT',
      data: { quantity: quantity }
    }).then(function() {
      var cartItems = that.data.cartItems.map(function(i) {
        if (i.id === id) {
          i.quantity = quantity
        }
        return i
      })
      that.setData({ cartItems: cartItems })
      that.calcTotal()
      // 更新购物车角标
      app.updateCartBadge()
    })
  },

  deleteItem: function(e) {
    var that = this
    var id = e.currentTarget.dataset.id
    
    wx.showModal({
      title: '提示',
      content: '确定删除该商品吗？',
      success: function(res) {
        if (res.confirm) {
          app.request({
            url: '/cart/' + id,
            method: 'DELETE'
          }).then(function() {
            var cartItems = that.data.cartItems.filter(function(i) { return i.id !== id })
            that.setData({ cartItems: cartItems })
            that.calcTotal()
            wx.showToast({ title: '已删除', icon: 'success' })
            // 更新购物车角标
            app.updateCartBadge()
          })
        }
      }
    })
  },

  checkout: function() {
    var cartItems = this.data.cartItems
    var selected = cartItems.filter(function(item) { return item.selected })
    
    if (selected.length === 0) {
      wx.showToast({ title: '请选择商品', icon: 'none' })
      return
    }

    var items = selected.map(function(item) {
      return {
        product_id: item.product_id,
        name: item.name,
        image: item.image,
        price: item.price,
        quantity: item.quantity
      }
    })

    wx.navigateTo({
      url: '/pages/order/order?items=' + encodeURIComponent(JSON.stringify(items))
    })
  },

  goIndex: function() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  goProduct: function(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product/product?id=' + id })
  }
})
