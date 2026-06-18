import { useEffect, useState } from 'react'
import { Row, Col, Card, Statistic, Table, Tag } from 'antd'
import {
  ShoppingOutlined,
  OrderedListOutlined,
  UserOutlined,
  DollarOutlined,
} from '@ant-design/icons'
import request from '../utils/request'
import dayjs from 'dayjs'

export default function Dashboard() {
  const [stats, setStats] = useState({
    productCount: 0,
    orderCount: 0,
    totalSales: 0,
    todayOrders: 0,
  })
  const [recentOrders, setRecentOrders] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      setLoading(true)
      // 获取商品列表统计
      const products = await request.get('/products/admin/all', { params: { limit: 1000 } })
      
      // 获取订单列表
      const orders = await request.get('/orders/admin/all', { params: { limit: 10 } })
      
      // 计算统计数据
      const today = dayjs().format('YYYY-MM-DD')
      const todayOrders = orders.list.filter(
        (o) => dayjs(o.created_at).format('YYYY-MM-DD') === today
      )
      const totalSales = orders.list.reduce((sum, o) => sum + o.total_amount, 0)

      setStats({
        productCount: products.total,
        orderCount: orders.total,
        totalSales,
        todayOrders: todayOrders.length,
      })
      setRecentOrders(orders.list.slice(0, 5))
    } catch (error) {
      console.error('获取数据失败', error)
    } finally {
      setLoading(false)
    }
  }

  const statusMap = {
    pending: { text: '待付款', color: 'orange' },
    paid: { text: '已付款', color: 'blue' },
    shipped: { text: '已发货', color: 'cyan' },
    completed: { text: '已完成', color: 'green' },
    cancelled: { text: '已取消', color: 'red' },
  }

  const columns = [
    {
      title: '订单号',
      dataIndex: 'order_no',
      key: 'order_no',
    },
    {
      title: '用户',
      dataIndex: 'user_nickname',
      key: 'user_nickname',
      render: (text) => text || '未知用户',
    },
    {
      title: '金额',
      dataIndex: 'total_amount',
      key: 'total_amount',
      render: (amount) => `¥${amount.toFixed(2)}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status) => {
        const s = statusMap[status] || { text: status, color: 'default' }
        return <Tag color={s.color}>{s.text}</Tag>
      },
    },
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (time) => dayjs(time).format('MM-DD HH:mm'),
    },
  ]

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>数据概览</h2>
      
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card className="dashboard-card">
            <Statistic
              title="商品总数"
              value={stats.productCount}
              prefix={<ShoppingOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="dashboard-card">
            <Statistic
              title="订单总数"
              value={stats.orderCount}
              prefix={<OrderedListOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="dashboard-card">
            <Statistic
              title="今日订单"
              value={stats.todayOrders}
              prefix={<UserOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="dashboard-card">
            <Statistic
              title="销售总额"
              value={stats.totalSales}
              precision={2}
              prefix={<DollarOutlined />}
              suffix="元"
            />
          </Card>
        </Col>
      </Row>

      <Card title="最近订单" style={{ marginTop: 24 }}>
        <Table
          columns={columns}
          dataSource={recentOrders}
          rowKey="id"
          loading={loading}
          pagination={false}
        />
      </Card>
    </div>
  )
}
