import { useEffect, useState } from 'react'
import {
  Table,
  Button,
  Space,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  message,
  Popconfirm,
  Image,
  Tag,
  Tabs,
  Descriptions,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, HistoryOutlined } from '@ant-design/icons'
import request from '../utils/request'
import dayjs from 'dayjs'

const { TabPane } = Tabs

const opTypeMap = {
  lock: { text: '预占', color: 'orange' },
  confirm: { text: '确认售出', color: 'green' },
  release: { text: '释放', color: 'red' },
}

export default function Products() {
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10, total: 0 })
  const [form] = Form.useForm()

  const [stockLogModalOpen, setStockLogModalOpen] = useState(false)
  const [currentProduct, setCurrentProduct] = useState(null)
  const [stockLogs, setStockLogs] = useState([])
  const [stockLogLoading, setStockLogLoading] = useState(false)
  const [stockLogPagination, setStockLogPagination] = useState({ current: 1, pageSize: 20, total: 0 })

  const [allStockLogs, setAllStockLogs] = useState([])
  const [allStockLogLoading, setAllStockLogLoading] = useState(false)
  const [allStockLogPagination, setAllStockLogPagination] = useState({ current: 1, pageSize: 50, total: 0 })

  useEffect(() => {
    fetchProducts()
    fetchCategories()
  }, [pagination.current])

  useEffect(() => {
    if (stockLogModalOpen && currentProduct) {
      fetchStockLogs(currentProduct.id, stockLogPagination.current)
    }
  }, [stockLogModalOpen, stockLogPagination.current])

  useEffect(() => {
    fetchAllStockLogs(allStockLogPagination.current)
  }, [allStockLogPagination.current])

  const fetchProducts = async () => {
    setLoading(true)
    try {
      const res = await request.get('/products/admin/all', {
        params: { page: pagination.current, limit: pagination.pageSize },
      })
      setProducts(res.list)
      setPagination((prev) => ({ ...prev, total: res.total }))
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }

  const fetchCategories = async () => {
    try {
      const res = await request.get('/categories')
      setCategories(res)
    } catch (error) {
      console.error(error)
    }
  }

  const fetchStockLogs = async (productId, page = 1) => {
    setStockLogLoading(true)
    try {
      const res = await request.get(`/products/admin/${productId}/stock-logs`, {
        params: { page, limit: stockLogPagination.pageSize },
      })
      setStockLogs(res.list)
      setStockLogPagination((prev) => ({ ...prev, total: res.total, current: page }))
    } catch (error) {
      console.error(error)
    } finally {
      setStockLogLoading(false)
    }
  }

  const fetchAllStockLogs = async (page = 1) => {
    setAllStockLogLoading(true)
    try {
      const res = await request.get('/products/admin/stock-logs/all', {
        params: { page, limit: allStockLogPagination.pageSize },
      })
      setAllStockLogs(res.list)
      setAllStockLogPagination((prev) => ({ ...prev, total: res.total, current: page }))
    } catch (error) {
      console.error(error)
    } finally {
      setAllStockLogLoading(false)
    }
  }

  const handleAdd = () => {
    setEditingId(null)
    form.resetFields()
    form.setFieldsValue({ status: true })
    setModalOpen(true)
  }

  const handleEdit = (record) => {
    setEditingId(record.id)
    form.setFieldsValue({
      ...record,
      total_stock: record.total_stock ?? record.stock,
      status: record.status === 1,
    })
    setModalOpen(true)
  }

  const handleViewStockLogs = (record) => {
    setCurrentProduct(record)
    setStockLogPagination({ current: 1, pageSize: 20, total: 0 })
    setStockLogModalOpen(true)
  }

  const handleDelete = async (id) => {
    try {
      await request.delete(`/products/${id}`)
      message.success('删除成功')
      fetchProducts()
    } catch (error) {
      console.error(error)
    }
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      const data = {
        ...values,
        status: values.status ? 1 : 0,
      }

      if (editingId) {
        await request.put(`/products/${editingId}`, data)
        message.success('更新成功')
      } else {
        await request.post('/products', data)
        message.success('创建成功')
      }

      setModalOpen(false)
      fetchProducts()
    } catch (error) {
      console.error(error)
      if (error.response?.data?.error) {
        message.error(error.response.data.error)
      }
    }
  }

  const productColumns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 60,
    },
    {
      title: '图片',
      dataIndex: 'image',
      key: 'image',
      width: 80,
      render: (url) => (
        <Image src={url} width={50} height={50} style={{ objectFit: 'cover', borderRadius: 4 }} />
      ),
    },
    {
      title: '商品名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: '价格',
      dataIndex: 'price',
      key: 'price',
      width: 100,
      render: (price) => `¥${price.toFixed(2)}`,
    },
    {
      title: '库存明细',
      key: 'stock_detail',
      width: 220,
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Space>
            <Tag color="green">可售: {record.available_stock ?? record.stock}</Tag>
            <Tag color="orange">预占: {record.locked_stock || 0}</Tag>
          </Space>
          <Space>
            <Tag color="blue">已售: {record.sold_stock || 0}</Tag>
            <Tag>总库存: {record.total_stock ?? record.stock}</Tag>
          </Space>
        </Space>
      ),
    },
    {
      title: '分类',
      dataIndex: 'category_name',
      key: 'category_name',
      width: 100,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 80,
      render: (status) => (
        <Tag color={status === 1 ? 'green' : 'red'}>
          {status === 1 ? '上架' : '下架'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<HistoryOutlined />}
            onClick={() => handleViewStockLogs(record)}
          >
            库存流水
          </Button>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确定删除该商品吗？"
            onConfirm={() => handleDelete(record.id)}
            okText="确定"
            cancelText="取消"
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const stockLogColumns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (time) => dayjs(time).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '操作类型',
      dataIndex: 'operation_type',
      key: 'operation_type',
      width: 100,
      render: (type) => (
        <Tag color={opTypeMap[type]?.color}>{opTypeMap[type]?.text || type}</Tag>
      ),
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 80,
    },
    {
      title: '订单号',
      dataIndex: 'order_no',
      key: 'order_no',
      width: 180,
    },
    {
      title: '库存变化',
      key: 'stock_change',
      render: (_, record) => (
        <Space size="small">
          <span>
            预占: {record.before_locked_stock} → {record.after_locked_stock}
          </span>
          <span style={{ color: '#999' }}>|</span>
          <span>
            已售: {record.before_sold_stock} → {record.after_sold_stock}
          </span>
        </Space>
      ),
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      ellipsis: true,
    },
  ]

  return (
    <div>
      <Tabs defaultActiveKey="products">
        <TabPane tab="商品管理" key="products">
          <div className="table-operations">
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              添加商品
            </Button>
          </div>

          <Table
            columns={productColumns}
            dataSource={products}
            rowKey="id"
            loading={loading}
            pagination={{
              ...pagination,
              showSizeChanger: false,
              showTotal: (total) => `共 ${total} 条`,
              onChange: (page) => setPagination((prev) => ({ ...prev, current: page })),
            }}
          />
        </TabPane>

        <TabPane tab="全部库存流水" key="allLogs">
          <Table
            columns={stockLogColumns}
            dataSource={allStockLogs}
            rowKey="id"
            loading={allStockLogLoading}
            pagination={{
              ...allStockLogPagination,
              showSizeChanger: false,
              showTotal: (total) => `共 ${total} 条流水记录`,
              onChange: (page) => setAllStockLogPagination((prev) => ({ ...prev, current: page })),
            }}
          />
        </TabPane>
      </Tabs>

      <Modal
        title={editingId ? '编辑商品' : '添加商品'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="商品名称"
            rules={[{ required: true, message: '请输入商品名称' }]}
          >
            <Input placeholder="请输入商品名称" />
          </Form.Item>

          <Form.Item name="description" label="商品描述">
            <Input.TextArea rows={3} placeholder="请输入商品描述" />
          </Form.Item>

          <Space style={{ display: 'flex' }}>
            <Form.Item
              name="price"
              label="售价"
              rules={[{ required: true, message: '请输入售价' }]}
            >
              <InputNumber
                min={0}
                precision={2}
                style={{ width: 150 }}
                prefix="¥"
                placeholder="售价"
              />
            </Form.Item>

            <Form.Item name="original_price" label="原价">
              <InputNumber
                min={0}
                precision={2}
                style={{ width: 150 }}
                prefix="¥"
                placeholder="原价"
              />
            </Form.Item>

            <Form.Item name="total_stock" label="总库存">
              <InputNumber min={0} style={{ width: 150 }} placeholder="总库存" />
            </Form.Item>
          </Space>

          <Form.Item name="category_id" label="分类">
            <Select placeholder="请选择分类" allowClear>
              {categories.map((c) => (
                <Select.Option key={c.id} value={c.id}>
                  {c.name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item name="image" label="商品图片">
            <Input placeholder="请输入图片URL" />
          </Form.Item>

          <Form.Item name="status" label="上架状态" valuePropName="checked">
            <Switch checkedChildren="上架" unCheckedChildren="下架" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={currentProduct ? `${currentProduct.name} - 库存流水` : '库存流水'}
        open={stockLogModalOpen}
        onCancel={() => setStockLogModalOpen(false)}
        footer={null}
        width={900}
      >
        {currentProduct && (
          <Descriptions bordered size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label="当前可售">
              <Tag color="green">{currentProduct.available_stock ?? 0}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="当前预占">
              <Tag color="orange">{currentProduct.locked_stock || 0}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="累计已售">
              <Tag color="blue">{currentProduct.sold_stock || 0}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="总库存">
              {currentProduct.total_stock || 0}
            </Descriptions.Item>
          </Descriptions>
        )}
        <Table
          columns={stockLogColumns}
          dataSource={stockLogs}
          rowKey="id"
          loading={stockLogLoading}
          size="small"
          pagination={{
            ...stockLogPagination,
            showSizeChanger: false,
            showTotal: (total) => `共 ${total} 条`,
            onChange: (page) => setStockLogPagination((prev) => ({ ...prev, current: page })),
          }}
        />
      </Modal>
    </div>
  )
}
