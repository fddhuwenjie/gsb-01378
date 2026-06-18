import { Form, Input, Button, message } from 'antd'
import { UserOutlined, LockOutlined, ShoppingOutlined } from '@ant-design/icons'
import request from '../utils/request'

export default function Login({ onLogin }) {
  const [form] = Form.useForm()

  const handleSubmit = async (values) => {
    try {
      const res = await request.post('/auth/login', values)
      localStorage.setItem('user', JSON.stringify(res.user))
      message.success('登录成功')
      onLogin(res.token)
    } catch (error) {
      // 错误已在拦截器中处理
    }
  }

  return (
    <div style={styles.container}>
      {/* 左侧装饰区 */}
      <div style={styles.leftPanel}>
        <div style={styles.brandArea}>
          <div style={styles.logoIcon}>
            <ShoppingOutlined style={{ fontSize: 48, color: '#fff' }} />
          </div>
          <h1 style={styles.brandTitle}>电商管理系统</h1>
          <p style={styles.brandDesc}>高效管理，智能运营</p>
        </div>
        <div style={styles.features}>
          <div style={styles.featureItem}>
            <span style={styles.featureIcon}>📊</span>
            <span>数据可视化分析</span>
          </div>
          <div style={styles.featureItem}>
            <span style={styles.featureIcon}>🛍️</span>
            <span>商品订单管理</span>
          </div>
          <div style={styles.featureItem}>
            <span style={styles.featureIcon}>👥</span>
            <span>用户会员管理</span>
          </div>
        </div>
      </div>

      {/* 右侧登录区 */}
      <div style={styles.rightPanel}>
        <div style={styles.loginBox}>
          <div style={styles.loginHeader}>
            <h2 style={styles.loginTitle}>欢迎回来</h2>
            <p style={styles.loginSubtitle}>请登录您的管理员账户</p>
          </div>

          <Form form={form} onFinish={handleSubmit} size="large" style={styles.form}>
            <Form.Item
              name="username"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input
                prefix={<UserOutlined style={{ color: '#bfbfbf' }} />}
                placeholder="用户名"
                style={styles.input}
              />
            </Form.Item>
            <Form.Item
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: '#bfbfbf' }} />}
                placeholder="密码"
                style={styles.input}
              />
            </Form.Item>
            <Form.Item style={{ marginBottom: 16 }}>
              <Button type="primary" htmlType="submit" block style={styles.submitBtn}>
                登 录
              </Button>
            </Form.Item>
          </Form>

          <div style={styles.demoInfo}>
            <div style={styles.demoTitle}>演示账号</div>
            <div style={styles.demoAccount}>
              <span>用户名: <code>admin</code></span>
              <span style={{ margin: '0 12px' }}>|</span>
              <span>密码: <code>admin123</code></span>
            </div>
          </div>
        </div>

        <div style={styles.footer}>
          © 2024 电商管理系统 · 技术支持
        </div>
      </div>
    </div>
  )
}

const styles = {
  container: {
    display: 'flex',
    minHeight: '100vh',
    background: '#f0f2f5',
  },
  // 左侧面板
  leftPanel: {
    flex: '0 0 45%',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '60px',
    position: 'relative',
    overflow: 'hidden',
  },
  brandArea: {
    textAlign: 'center',
    marginBottom: 60,
    position: 'relative',
    zIndex: 1,
  },
  logoIcon: {
    width: 100,
    height: 100,
    background: 'rgba(255,255,255,0.2)',
    borderRadius: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 24px',
    backdropFilter: 'blur(10px)',
  },
  brandTitle: {
    color: '#fff',
    fontSize: 36,
    fontWeight: 700,
    margin: '0 0 12px',
    letterSpacing: 2,
  },
  brandDesc: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 18,
    margin: 0,
  },
  features: {
    position: 'relative',
    zIndex: 1,
  },
  featureItem: {
    display: 'flex',
    alignItems: 'center',
    color: 'rgba(255,255,255,0.9)',
    fontSize: 16,
    marginBottom: 20,
    padding: '12px 24px',
    background: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    backdropFilter: 'blur(10px)',
  },
  featureIcon: {
    fontSize: 24,
    marginRight: 16,
  },
  // 右侧面板
  rightPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '60px',
    background: '#fff',
  },
  loginBox: {
    width: '100%',
    maxWidth: 400,
  },
  loginHeader: {
    textAlign: 'center',
    marginBottom: 40,
  },
  loginTitle: {
    fontSize: 28,
    fontWeight: 600,
    color: '#1a1a2e',
    margin: '0 0 8px',
  },
  loginSubtitle: {
    fontSize: 15,
    color: '#8c8c8c',
    margin: 0,
  },
  form: {
    marginBottom: 32,
  },
  input: {
    height: 50,
    borderRadius: 8,
    fontSize: 15,
  },
  submitBtn: {
    height: 50,
    borderRadius: 8,
    fontSize: 16,
    fontWeight: 600,
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    border: 'none',
  },
  demoInfo: {
    background: '#f8f9fa',
    borderRadius: 12,
    padding: '16px 20px',
    textAlign: 'center',
  },
  demoTitle: {
    fontSize: 13,
    color: '#8c8c8c',
    marginBottom: 8,
  },
  demoAccount: {
    fontSize: 14,
    color: '#595959',
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    color: '#bfbfbf',
    fontSize: 13,
  },
}
