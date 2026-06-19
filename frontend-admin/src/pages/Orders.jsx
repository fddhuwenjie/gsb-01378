import { useEffect, useState } from 'react'
import {
  Table,
  Tag,
  Space,
  Button,
  Select,
  Modal,
  Descriptions,
  message,
  Image,
} from 'antd'
import { EyeOutlined } from '@ant-design/icons'
import request from '../utils/request'
import dayjs from 'dayjs'

const statusMap = {
  pending: { text: '待付款', color: 'orange' },
  paid: { text: '已付款', color: 'blue' },
  shipped: { text: '已发货', color: 'cyan' },
  completed: { text: '已完成', color: 'green' },
  cancelled: { text: '已取消', color: 'red' },
  timeout: { text: '已超时', color: 'default' },
}

const statusOptions = [
  { value: 'pending', label: '待付款' },
  { value: 'paid', label: '已付款' },
  { value: 'shipped', label: '已发货' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'timeout', label: '已超时' },
]

function formatRemainingTime(seconds) {
  if (!seconds || seconds <= 0) return '已超时'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}分${secs}秒`
}

export default function Orders() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(false)
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10, total: 0 })
  const [filterStatus, setFilterStatus] = useState(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [currentOrder, setCurrentOrder] = useState(null)

  useEffect(() => {
    fetchOrders()
  }, [pagination.current, filterStatus])

  const fetchOrders = async () => {
    setLoading(true)
    try {
      const params = { page: pagination.current, limit: pagination.pageSize }
      if (filterStatus) {
        params.status = filterStatus
      }
      const res = await request.get('/orders/admin/all', { params })
      setOrders(res.list)
      setPagination((prev) => ({ ...prev, total: res.total }))
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }

  const handleStatusChange = async (orderId, newStatus) => {
    try {
      await request.put(`/orders/admin/${orderId}/status`, { status: newStatus })
      message.success('状态更新成功')
      fetchOrders()
    } catch (error) {
      console.error(error)
    }
  }

  const showDetail = (order) => {
    setCurrentOrder(order)
    setDetailOpen(true)
  }

  const columns = [
    {
      title: '订单号',
      dataIndex: 'order_no',
      key: 'order_no',
      width: 180,
    },
    {
      title: '用户',
      dataIndex: 'user_nickname',
      key: 'user_nickname',
      width: 100,
      render: (text) => text || '未知用户',
    },
    {
      title: '商品数',
      key: 'items_count',
      width: 80,
      render: (_, record) => record.items?.length || 0,
    },
    {
      title: '金额',
      dataIndex: 'total_amount',
      key: 'total_amount',
      width: 100,
      render: (amount) => `¥${amount.toFixed(2)}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status, record) => (
        <Select
          value={status}
          size="small"
          style={{ width: 100 }}
          onChange={(value) => handleStatusChange(record.id, value)}
          options={statusOptions}
        />
      ),
    },
    {
      title: '支付剩余',
      key: 'pay_remaining',
      width: 100,
      render: (_, record) => {
        if (record.status !== 'pending') return '-'
        return (
          <Tag color={record.pay_expired ? 'red' : 'orange'}>
            {record.pay_expired ? '已超时' : formatRemainingTime(record.pay_expire_remaining)}
          </Tag>
        )
      },
    },
    {
      title: '下单时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (time) => dayjs(time).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_, record) => (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => showDetail(record)}
        >
          详情
        </Button>
      ),
    },
  ]

  return (
    <div>
      <div className="table-operations">
        <Space>
          <span>状态筛选：</span>
          <Select
            value={filterStatus}
            style={{ width: 120 }}
            allowClear
            placeholder="全部状态"
            options={statusOptions}
            onChange={(value) => {
              setFilterStatus(value)
              setPagination((prev) => ({ ...prev, current: 1 }))
            }}
          />
        </Space>
      </div>

      <Table
        columns={columns}
        dataSource={orders}
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
        title="订单详情"
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        footer={null}
        width={700}
      >
        {currentOrder && (
          <>
            <Descriptions column={2} bordered size="small">
              <Descriptions.Item label="订单号">{currentOrder.order_no}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={statusMap[currentOrder.status]?.color}>
                  {statusMap[currentOrder.status]?.text}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="订单金额">
                ¥{currentOrder.total_amount?.toFixed(2)}
              </Descriptions.Item>
              <Descriptions.Item label="下单时间">
                {dayjs(currentOrder.created_at).format('YYYY-MM-DD HH:mm:ss')}
              </Descriptions.Item>
              <Descriptions.Item label="收货人">{currentOrder.receiver_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="联系电话">{currentOrder.receiver_phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="收货地址" span={2}>
                {currentOrder.address || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>
                {currentOrder.remark || '-'}
              </Descriptions.Item>
            </Descriptions>

            <h4 style={{ margin: '16px 0 8px' }}>商品列表</h4>
            <Table
              dataSource={currentOrder.items}
              rowKey="id"
              pagination={false}
              size="small"
              columns={[
                {
                  title: '图片',
                  dataIndex: 'product_image',
                  key: 'product_image',
                  width: 60,
                  render: (url) => (
                    <Image src={url} width={40} height={40} style={{ objectFit: 'cover' }} />
                  ),
                },
                {
                  title: '商品名称',
                  dataIndex: 'product_name',
                  key: 'product_name',
                },
                {
                  title: '单价',
                  dataIndex: 'price',
                  key: 'price',
                  render: (price) => `¥${price.toFixed(2)}`,
                },
                {
                  title: '数量',
                  dataIndex: 'quantity',
                  key: 'quantity',
                },
                {
                  title: '小计',
                  key: 'subtotal',
                  render: (_, record) => `¥${(record.price * record.quantity).toFixed(2)}`,
                },
              ]}
            />
          </>
        )}
      </Modal>
    </div>
  )
}
