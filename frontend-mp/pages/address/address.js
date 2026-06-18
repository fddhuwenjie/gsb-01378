var app = getApp()

Page({
  data: {
    addresses: [],
    loading: true,
    showForm: false,
    editId: null,
    regionArray: [],
    form: {
      name: '',
      phone: '',
      region: '',
      detail: '',
      is_default: false
    }
  },

  onLoad: function() {
    this.loadAddresses()
  },

  loadAddresses: function() {
    var that = this
    this.setData({ loading: true })
    
    app.request({ url: '/addresses' }).then(function(res) {
      that.setData({ addresses: res || [], loading: false })
    }).catch(function(err) {
      console.error('加载地址失败', err)
      that.setData({ loading: false })
    })
  },

  showAddForm: function() {
    this.setData({
      showForm: true,
      editId: null,
      regionArray: [],
      form: { name: '', phone: '', region: '', detail: '', is_default: false }
    })
  },

  editAddress: function(e) {
    var item = e.currentTarget.dataset.item
    var regionArray = item.region ? item.region.split(' ') : []
    this.setData({
      showForm: true,
      editId: item.id,
      regionArray: regionArray,
      form: {
        name: item.name,
        phone: item.phone,
        region: item.region,
        detail: item.detail,
        is_default: item.is_default === 1
      }
    })
  },

  closeForm: function() {
    this.setData({ showForm: false })
  },

  onInput: function(e) {
    var field = e.currentTarget.dataset.field
    var form = this.data.form
    form[field] = e.detail.value
    this.setData({ form: form })
  },

  toggleDefault: function() {
    var form = this.data.form
    form.is_default = !form.is_default
    this.setData({ form: form })
  },

  onRegionChange: function(e) {
    var value = e.detail.value
    var form = this.data.form
    form.region = value.join(' ')
    this.setData({ form: form, regionArray: value })
  },

  saveAddress: function() {
    var that = this
    var form = this.data.form

    if (!form.name.trim()) {
      wx.showToast({ title: '请输入收货人', icon: 'none' })
      return
    }
    if (!form.phone.trim() || !/^1\d{10}$/.test(form.phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' })
      return
    }
    if (!form.region.trim()) {
      wx.showToast({ title: '请选择所在地区', icon: 'none' })
      return
    }
    if (!form.detail.trim()) {
      wx.showToast({ title: '请输入详细地址', icon: 'none' })
      return
    }

    var url = this.data.editId ? '/addresses/' + this.data.editId : '/addresses'
    var method = this.data.editId ? 'PUT' : 'POST'

    app.request({
      url: url,
      method: method,
      data: {
        name: form.name,
        phone: form.phone,
        region: form.region,
        detail: form.detail,
        is_default: form.is_default ? 1 : 0
      }
    }).then(function() {
      wx.showToast({ title: '保存成功', icon: 'success' })
      that.setData({ showForm: false })
      that.loadAddresses()
    }).catch(function(err) {
      console.error('保存地址失败', err)
    })
  },

  deleteAddress: function(e) {
    var that = this
    var id = e.currentTarget.dataset.id

    wx.showModal({
      title: '提示',
      content: '确定删除该地址吗？',
      success: function(res) {
        if (res.confirm) {
          app.request({
            url: '/addresses/' + id,
            method: 'DELETE'
          }).then(function() {
            wx.showToast({ title: '已删除', icon: 'success' })
            that.loadAddresses()
          })
        }
      }
    })
  },

  setDefault: function(e) {
    var that = this
    var id = e.currentTarget.dataset.id

    app.request({
      url: '/addresses/' + id + '/default',
      method: 'PUT'
    }).then(function() {
      that.loadAddresses()
    })
  }
})
