import React, { useState } from 'react';

interface LoginRegisterModalProps {
  isOpen: boolean;
  onClose?: () => void;
  onRegister: (name: string, password: string, phone: string) => void;
  onLogin: (name: string, password: string) => void;
}

export const LoginRegisterModal: React.FC<LoginRegisterModalProps> = ({
  isOpen,
  onRegister,
  onLogin,
}) => {
  const [activeTab, setActiveTab] = useState<'register' | 'login'>('register');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');

  if (!isOpen) return null;

  const handleSubmit = () => {
    if (activeTab === 'register') {
      if (!name || !password || !phone) {
        // alert('请填写完整信息');
        return;
      }
      onRegister(name, password, phone);
    } else {
      if (!name || !password) {
        // alert('请填写用户名和密码');
        return;
      }
      onLogin(name, password);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      padding: '20px',
    }}>
      <div style={{
        background: 'white',
        borderRadius: '16px',
        padding: '0',
        maxWidth: '400px',
        width: '100%',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1)',
        overflow: 'hidden',
      }}>
        {/* Tab Header */}
        <div style={{
          display: 'flex',
          borderBottom: '1px solid #e5e7eb',
        }}>
          <button
            onClick={() => setActiveTab('register')}
            style={{
              flex: 1,
              padding: '16px',
              background: activeTab === 'register' ? 'white' : '#f9fafb',
              border: 'none',
              borderBottom: activeTab === 'register' ? '2px solid #667eea' : '2px solid transparent',
              fontSize: '16px',
              fontWeight: activeTab === 'register' ? 600 : 400,
              color: activeTab === 'register' ? '#667eea' : '#6b7280',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            注册
          </button>
          <div style={{
            width: '1px',
            background: '#e5e7eb',
          }} />
          <button
            onClick={() => setActiveTab('login')}
            style={{
              flex: 1,
              padding: '16px',
              background: activeTab === 'login' ? 'white' : '#f9fafb',
              border: 'none',
              borderBottom: activeTab === 'login' ? '2px solid #667eea' : '2px solid transparent',
              fontSize: '16px',
              fontWeight: activeTab === 'login' ? 600 : 400,
              color: activeTab === 'login' ? '#667eea' : '#6b7280',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            登录
          </button>
        </div>

        {/* Form Content */}
        <div style={{ padding: '32px 24px' }}>
          <h2 style={{
            margin: '0 0 24px 0',
            fontSize: '20px',
            fontWeight: 600,
            color: '#1a1a1a',
            textAlign: 'center',
          }}>
            {activeTab === 'register' ? '创建新账号' : '欢迎回来'}
          </h2>

          {/* Username */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{
              display: 'block',
              marginBottom: '8px',
              fontSize: '14px',
              fontWeight: 500,
              color: '#374151',
            }}>
              用户名
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="请输入用户名"
              style={{
                width: '100%',
                padding: '12px',
                border: '1px solid #d1d5db',
                borderRadius: '8px',
                fontSize: '14px',
                outline: 'none',
                transition: 'border-color 0.2s',
                boxSizing: 'border-box',
              }}
              onFocus={(e) => e.target.style.borderColor = '#667eea'}
              onBlur={(e) => e.target.style.borderColor = '#d1d5db'}
            />
          </div>

          {/* Password */}
          <div style={{ marginBottom: activeTab === 'register' ? '16px' : '24px' }}>
            <label style={{
              display: 'block',
              marginBottom: '8px',
              fontSize: '14px',
              fontWeight: 500,
              color: '#374151',
            }}>
              密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              style={{
                width: '100%',
                padding: '12px',
                border: '1px solid #d1d5db',
                borderRadius: '8px',
                fontSize: '14px',
                outline: 'none',
                transition: 'border-color 0.2s',
                boxSizing: 'border-box',
              }}
              onFocus={(e) => e.target.style.borderColor = '#667eea'}
              onBlur={(e) => e.target.style.borderColor = '#d1d5db'}
            />
          </div>

          {/* Phone (Register only) */}
          {activeTab === 'register' && (
            <div style={{ marginBottom: '24px' }}>
              <label style={{
                display: 'block',
                marginBottom: '8px',
                fontSize: '14px',
                fontWeight: 500,
                color: '#374151',
              }}>
                手机号
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="请输入手机号"
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '1px solid #d1d5db',
                  borderRadius: '8px',
                  fontSize: '14px',
                  outline: 'none',
                  transition: 'border-color 0.2s',
                  boxSizing: 'border-box',
                }}
                onFocus={(e) => e.target.style.borderColor = '#667eea'}
                onBlur={(e) => e.target.style.borderColor = '#d1d5db'}
              />
            </div>
          )}

          {/* Submit Button */}
          <button
            onClick={handleSubmit}
            style={{
              width: '100%',
              padding: '14px',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '16px',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'transform 0.2s, box-shadow 0.2s',
              boxShadow: '0 4px 12px rgba(102, 126, 234, 0.4)',
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.transform = 'scale(0.98)';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
            }}
          >
            {activeTab === 'register' ? '立即注册' : '登录'}
          </button>
        </div>
      </div>
    </div>
  );
};
