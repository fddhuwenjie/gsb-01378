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
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, HistoryOutlined } from '@ant-design/icons'
import request from '../utils/request'
import dayjs from 'dayjs'

const stockActionMap = {
  reserve: { text: '下单预占', color: 'orange' },
  commit: { text: '支付提交', color: 'blue' },
  release: { text: '取消释放', color: 'default' },
  expire: { text: '超时回收', color: 'red' },
}

export default function Products() {
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10, total: 0 })
  const [form] = Form.useForm()
  const [stockLogOpen, setStockLogOpen] = useState(false)
  const [stockLogProduct, setStockLogProduct] = useState(null)
  const [stockLogs, setStockLogs] = useState([])
  const [stockLogLoading, setStockLogLoading] = useState(false)

  const showStockLogs = async (product) => {
    setStockLogProduct(product)
    setStockLogOpen(true)
    setStockLogLoading(true)
    try {
      const res = await request.get('/orders/admin/stock-logs', {
        params: { product_id: product.id, limit: 50 },
      })
      setStockLogs(res.list || [])
    } catch (e) {
      console.error(e)
    } finally {
      setStockLogLoading(false)
    }
  }

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
      title: '可售库存',
      dataIndex: 'stock',
      key: 'stock',
      width: 90,
      render: (v) => <Tag color={v > 0 ? 'green' : 'red'}>{v}</Tag>,
    },
    {
      title: '预占库存',
      dataIndex: 'stock_reserved',
      key: 'stock_reserved',
      width: 90,
      render: (v) => <Tag color={v > 0 ? 'orange' : 'default'}>{v || 0}</Tag>,
    },
    {
      title: '已售库存',
      dataIndex: 'stock_sold',
      key: 'stock_sold',
      width: 90,
      render: (v) => <Tag color={v > 0 ? 'blue' : 'default'}>{v || 0}</Tag>,
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
      width: 220,
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
          <Button
            type="link"
            size="small"
            icon={<HistoryOutlined />}
            onClick={() => showStockLogs(record)}
          >
            流水
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
      <div className="table-operations">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          添加商品
        </Button>
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

            <Form.Item name="stock" label="库存">
              <InputNumber min={0} style={{ width: 150 }} placeholder="库存" />
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
        title={stockLogProduct ? `库存流水 - ${stockLogProduct.name}` : '库存流水'}
        open={stockLogOpen}
        onCancel={() => setStockLogOpen(false)}
        footer={null}
        width={760}
      >
        {stockLogProduct && (
          <div style={{ marginBottom: 12 }}>
            <Tag color="green">可售 {stockLogProduct.stock}</Tag>
            <Tag color="orange">预占 {stockLogProduct.stock_reserved || 0}</Tag>
            <Tag color="blue">已售 {stockLogProduct.stock_sold || 0}</Tag>
          </div>
        )}
        <Table
          dataSource={stockLogs}
          loading={stockLogLoading}
          rowKey="id"
          size="small"
          pagination={false}
          columns={[
            {
              title: '时间',
              dataIndex: 'created_at',
              width: 160,
              render: (t) => dayjs(t).format('YYYY-MM-DD HH:mm:ss'),
            },
            {
              title: '订单号',
              dataIndex: 'order_no',
              width: 180,
            },
            {
              title: '动作',
              dataIndex: 'action',
              width: 110,
              render: (a) => {
                const m = stockActionMap[a] || { text: a, color: 'default' }
                return <Tag color={m.color}>{m.text}</Tag>
              },
            },
            {
              title: '数量',
              dataIndex: 'quantity',
              width: 80,
            },
            {
              title: '备注',
              dataIndex: 'remark',
            },
          ]}
        />
      </Modal>
    </div>
  )
}
