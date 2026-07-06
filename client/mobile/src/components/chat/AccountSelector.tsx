import React from 'react';

interface AccountSelectorProps {
  savedAccountName: string;
  onUseSavedAccount: () => void;
  onUseOtherAccount: () => void;
}

export const AccountSelector: React.FC<AccountSelectorProps> = ({
  savedAccountName,
  onUseSavedAccount,
  onUseOtherAccount,
}) => {
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
        padding: '32px 24px',
        maxWidth: '400px',
        width: '100%',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1)',
      }}>
        <h2 style={{
          margin: '0 0 12px 0',
          fontSize: '24px',
          fontWeight: 600,
          color: '#1a1a1a',
          textAlign: 'center',
        }}>
          选择登录方式
        </h2>
        
        <p style={{
          margin: '0 0 32px 0',
          fontSize: '14px',
          color: '#666',
          textAlign: 'center',
        }}>
          检测到已保存的账号信息
        </p>

        {/* Saved Account Option */}
        <button
          onClick={onUseSavedAccount}
          style={{
            width: '100%',
            padding: '16px',
            marginBottom: '12px',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '12px',
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
          <div style={{ marginBottom: '4px' }}>使用已保存账号</div>
          <div style={{ fontSize: '13px', opacity: 0.9 }}>
            {savedAccountName}
          </div>
        </button>

        {/* Other Account Option */}
        <button
          onClick={onUseOtherAccount}
          style={{
            width: '100%',
            padding: '16px',
            background: 'white',
            color: '#667eea',
            border: '2px solid #667eea',
            borderRadius: '12px',
            fontSize: '16px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s',
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
          使用其他账号登录
        </button>
      </div>
    </div>
  );
};
