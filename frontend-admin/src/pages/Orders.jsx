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
  Statistic,
  Row,
  Col,
  Card,
} from 'antd'
import { EyeOutlined, ClockCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
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
  { value: 'cancelled', label: '已取消/超时' },
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
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

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
      
      const ordersWithCountdown = res.list.map(order => {
        let remainingSeconds = 0
        let isExpired = false
        if (order.status === 'pending' && order.pay_expire_time) {
          const expireTime = dayjs(order.pay_expire_time).valueOf()
          remainingSeconds = Math.max(0, Math.floor((expireTime - now) / 1000))
          isExpired = remainingSeconds === 0
        }
        return { ...order, remainingSeconds, isExpired }
      })
      
      setOrders(ordersWithCountdown)
      setPagination((prev) => ({ ...prev, total: res.total }))
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }

  const handleProcessExpired = async () => {
    try {
      const res = await request.post('/orders/admin/process-expired')
      message.success(res.message)
      fetchOrders()
    } catch (error) {
      console.error(error)
      message.error('处理超时订单失败')
    }
  }

  const handleStatusChange = async (orderId, newStatus) => {
    try {
      await request.put(`/orders/admin/${orderId}/status`, { status: newStatus })
      message.success('状态更新成功')
      fetchOrders()
    } catch (error) {
      console.error(error)
      message.error(error?.response?.data?.error || '状态更新失败')
    }
  }

  const showDetail = (order) => {
    let remainingSeconds = 0
    if (order.status === 'pending' && order.pay_expire_time) {
      const expireTime = dayjs(order.pay_expire_time).valueOf()
      remainingSeconds = Math.max(0, Math.floor((expireTime - now) / 1000))
    }
    setCurrentOrder({ ...order, remainingSeconds })
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
      key: 'status_info',
      width: 180,
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Select
            value={record.status}
            size="small"
            style={{ width: 110 }}
            onChange={(value) => handleStatusChange(record.id, value)}
            options={statusOptions.filter(opt => {
              if (record.status === 'paid' && opt.value !== 'shipped' && opt.value !== 'completed' && opt.value !== 'paid') return false
              if (record.status === 'shipped' && opt.value !== 'completed' && opt.value !== 'shipped') return false
              if ((record.status === 'cancelled' || record.status === 'timeout' || record.status === 'completed') && opt.value !== record.status) return false
              return true
            })}
          />
          {record.status === 'pending' && record.remainingSeconds > 0 && (
            <span style={{ fontSize: 12, color: record.remainingSeconds < 300 ? '#ff4d4f' : '#faad14' }}>
              <ClockCircleOutlined /> {formatRemainingTime(record.remainingSeconds)}
            </span>
          )}
          {record.status === 'pending' && record.isExpired && (
            <span style={{ fontSize: 12, color: '#999' }}>
              <ExclamationCircleOutlined /> 等待超时处理
            </span>
          )}
        </Space>
      ),
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
      <div className="table-operations" style={{ marginBottom: 16 }}>
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
          <Button onClick={handleProcessExpired} danger>
            立即处理超时订单
          </Button>
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
            {currentOrder.status === 'pending' && currentOrder.pay_expire_time && (
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={12}>
                  <Card>
                    <Statistic
                      title="剩余支付时间"
                      value={formatRemainingTime(currentOrder.remainingSeconds)}
                      valueStyle={{ color: currentOrder.remainingSeconds < 300 ? '#ff4d4f' : '#faad14' }}
                      prefix={<ClockCircleOutlined />}
                    />
                  </Card>
                </Col>
                <Col span={12}>
                  <Card>
                    <Statistic
                      title="支付截止时间"
                      value={dayjs(currentOrder.pay_expire_time).format('MM-DD HH:mm:ss')}
                    />
                  </Card>
                </Col>
              </Row>
            )}

            <Descriptions column={2} bordered size="small">
              <Descriptions.Item label="订单号">{currentOrder.order_no}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={statusMap[currentOrder.status]?.color || 'default'}>
                  {statusMap[currentOrder.status]?.text || currentOrder.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="订单金额">
                ¥{currentOrder.total_amount?.toFixed(2)}
              </Descriptions.Item>
              <Descriptions.Item label="下单时间">
                {dayjs(currentOrder.created_at).format('YYYY-MM-DD HH:mm:ss')}
              </Descriptions.Item>
              {currentOrder.paid_at && (
                <Descriptions.Item label="支付时间" span={2}>
                  {dayjs(currentOrder.paid_at).format('YYYY-MM-DD HH:mm:ss')}
                </Descriptions.Item>
              )}
              {currentOrder.cancelled_at && (
                <Descriptions.Item label="关闭时间" span={2}>
                  {dayjs(currentOrder.cancelled_at).format('YYYY-MM-DD HH:mm:ss')}
                </Descriptions.Item>
              )}
              <Descriptions.Item label="收货人">{currentOrder.receiver_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="联系电话">{currentOrder.receiver_phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="收货地址" span={2}>
                {currentOrder.address || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>
                {currentOrder.remark || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="库存状态" span={2}>
                <Space>
                  <Tag color={currentOrder.stock_locked ? 'orange' : 'default'}>
                    {currentOrder.stock_locked ? '库存已预占' : '库存未锁定'}
                  </Tag>
                  <Tag color={currentOrder.stock_processed ? 'green' : 'default'}>
                    {currentOrder.stock_processed ? '库存已扣减' : '库存未确认'}
                  </Tag>
                </Space>
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
