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
  Card,
  Row,
  Col,
  Statistic,
  Timeline,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, StockOutlined, HistoryOutlined } from '@ant-design/icons'
import request from '../utils/request'
import dayjs from 'dayjs'

export default function Products() {
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10, total: 0 })
  const [form] = Form.useForm()
  const [stockModalOpen, setStockModalOpen] = useState(false)
  const [stockSummary, setStockSummary] = useState(null)
  const [stockLogs, setStockLogs] = useState([])

  useEffect(() => {
    fetchProducts()
    fetchCategories()
  }, [pagination.current])

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

  const fetchStockSummary = async () => {
    try {
      const res = await request.get('/products/admin/stock-summary')
      setStockSummary(res.summary)
      setStockLogs(res.recent_logs)
      setStockModalOpen(true)
    } catch (error) {
      console.error(error)
      message.error('获取库存统计失败')
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
      stock: record.total_stock,
      status: record.status === 1,
    })
    setModalOpen(true)
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
    }
  }

  const logTypeColor = (type) => {
    const map = {
      reserve: 'orange',
      confirm: 'green',
      release: 'blue',
      admin_adjust: 'purple'
    }
    return map[type] || 'default'
  }

  const logTypeText = (type) => {
    const map = {
      reserve: '预占',
      confirm: '扣减确认',
      release: '释放',
      admin_adjust: '调整'
    }
    return map[type] || type
  }

  const columns = [
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
      title: '库存状态',
      key: 'stock_info',
      width: 240,
      render: (_, record) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Space>
            <Tag color="green">可售: {record.available_stock}</Tag>
            <Tag color="orange">预占: {record.reserved_stock}</Tag>
          </Space>
          <Space>
            <Tag color="blue">总库存: {record.total_stock}</Tag>
            <Tag color="purple">已售: {record.sold_stock}</Tag>
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
      width: 150,
      render: (_, record) => (
        <Space>
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

  return (
    <div>
      <div className="table-operations" style={{ marginBottom: 16 }}>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            添加商品
          </Button>
          <Button icon={<StockOutlined />} onClick={fetchStockSummary}>
            库存总览与流水
          </Button>
        </Space>
      </div>

      <Table
        columns={columns}
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

            <Form.Item 
              name="stock" 
              label="总库存"
              extra={editingId ? '修改总库存将直接调整可用库存' : ''}
            >
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
        title="库存总览与流水"
        open={stockModalOpen}
        onCancel={() => setStockModalOpen(false)}
        footer={null}
        width={800}
      >
        {stockSummary && (
          <>
            <Row gutter={16} style={{ marginBottom: 24 }}>
              <Col span={6}>
                <Card>
                  <Statistic
                    title="商品总数"
                    value={stockSummary.total_products}
                    prefix={<StockOutlined />}
                  />
                </Card>
              </Col>
              <Col span={6}>
                <Card>
                  <Statistic
                    title="可售库存"
                    value={stockSummary.total_available}
                    valueStyle={{ color: '#52c41a' }}
                  />
                </Card>
              </Col>
              <Col span={6}>
                <Card>
                  <Statistic
                    title="预占库存"
                    value={stockSummary.total_reserved}
                    valueStyle={{ color: '#faad14' }}
                  />
                </Card>
              </Col>
              <Col span={6}>
                <Card>
                  <Statistic
                    title="已售库存"
                    value={stockSummary.total_sold}
                    valueStyle={{ color: '#1890ff' }}
                  />
                </Card>
              </Col>
            </Row>

            <h4 style={{ marginBottom: 12 }}>
              <HistoryOutlined /> 最近库存流水
            </h4>
            <Timeline
              items={stockLogs.map(log => ({
                color: logTypeColor(log.type),
                children: (
                  <div>
                    <Space>
                      <Tag color={logTypeColor(log.type)}>{logTypeText(log.type)}</Tag>
                      <span style={{ fontWeight: 500 }}>{log.product_name}</span>
                      <span>数量: {log.quantity > 0 ? '+' : ''}{log.type === 'release' || log.type === 'confirm' ? '-' : '+'}{log.quantity}</span>
                    </Space>
                    <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                      订单号: {log.order_no || '-'} | {log.remark} | {dayjs(log.created_at).format('YYYY-MM-DD HH:mm:ss')}
                    </div>
                  </div>
                )
              }))}
            />
          </>
        )}
      </Modal>
    </div>
  )
}
