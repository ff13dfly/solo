import { useState, useEffect } from 'react';
import { ChatLayout } from './components/chat/ChatLayout';
import type { Message } from './types';
import { LoginRegisterModal } from './components/chat/LoginRegisterModal';
import { PinPadModal } from './components/chat/PinPadModal';
import { AccountSelector } from './components/chat/AccountSelector';
import { SummaryCard } from './components/focus/SummaryCard';
import { FocusInputModal } from './components/focus/FocusInputModal';
import { SettingsModal } from './components/chat/SettingsModal';
import { GlobalErrorToast } from './components/GlobalErrorToast';
import { loginUser } from './lib/api';
import { AppError, ErrorCode } from './lib/errors';
import { useError } from './context/ErrorContext';

import { useAppInit } from './hooks/useAppInit';
import { useMobileAuth } from './hooks/useMobileAuth';
import { useChatLogic } from './hooks/useChatLogic';
import { useUserAvatar } from './hooks/useUserAvatar';

type Theme = 'light' | 'dark' | 'ocean' | 'forest';

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [savedAccountName, setSavedAccountName] = useState(() => localStorage.getItem("chat_user_profile") ? JSON.parse(localStorage.getItem("chat_user_profile")!).name : "");
  
  // Theme State
  const [currentTheme, setCurrentTheme] = useState<Theme>(() => (localStorage.getItem('app_theme') as Theme) || 'light');

  const { showError } = useError();

  // Apply Theme Effect
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark', 'theme-ocean', 'theme-forest');
    
    if (currentTheme === 'dark') {
      root.classList.add('dark');
    } else if (currentTheme === 'ocean') {
      root.classList.add('theme-ocean');
    } else if (currentTheme === 'forest') {
      root.classList.add('theme-forest');
    } else {
      root.classList.add('light'); 
    }
    
    localStorage.setItem('app_theme', currentTheme);
  }, [currentTheme]);

  const toggleTheme = () => {
    const themes: Theme[] = ['light', 'dark', 'ocean', 'forest'];
    const nextIndex = (themes.indexOf(currentTheme) + 1) % themes.length;
    setCurrentTheme(themes[nextIndex]);
  };
  
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // Auth Hook
  const {
      showLoginRegister, setShowLoginRegister,
      showPinSetup, setShowPinSetup,
      showPinLogin, setShowPinLogin,
      showAccountSelector,
      setPendingRegData,
      handleRegister,
      handlePinSetupSuccess,
      handlePinLoginSuccess,
      handleUseSavedAccount,
      handleUseOtherAccount
  } = useMobileAuth({ setMessages, setSavedAccountName });

  // Init Hook
  const { isMobileDevice } = useAppInit({ setMessages, setSavedAccountName, setShowPinLogin });

  // Chat Logic Hook (with Focus)
  const {
      appName,
      handleTitleClick,
      handleMessageAction,
      handleSendMessage,
      // Focus exports
      focus,
      handleFocusConfirm,
      handleFocusCancel,
      handleFieldClick,
      editingField,
      setEditingField,
      handleInputSubmit
  } = useChatLogic({ messages, setMessages, setShowLoginRegister });

  // Avatar Hook
  const {
      userAvatar,
      fileInputRef,
      handleAvatarClick,
      handleFileChange
  } = useUserAvatar();


  if (!isMobileDevice) {
      return (
          <div className="flex items-center justify-center h-screen w-screen bg-gray-100 text-gray-600 p-8 text-center">
              <div>
                  <h1 className="text-2xl font-bold mb-4">不支持桌面端访问</h1>
                  <p>请使用手机浏览器打开本应用以获得最佳体验。</p>
              </div>
          </div>
      );
  }

  return (
    <>
      <GlobalErrorToast />
      <ChatLayout 
        messages={messages} 
        onSendMessage={handleSendMessage}
        title={appName}
        onTitleClick={handleTitleClick}
        onAction={handleMessageAction}
        userAvatar={userAvatar}
        onUserAvatarClick={handleAvatarClick}
        // Focus SummaryCard slot
        focusCard={focus.isInFocus ? (
          <SummaryCard 
            focusState={focus.focusState}
            onConfirm={handleFocusConfirm}
            onCancel={handleFocusCancel}
            onFieldClick={handleFieldClick}
          />
        ) : null}
        // Theme props
        currentTheme={currentTheme}
        onToggleTheme={toggleTheme}
        onSettingsClick={() => setShowSettingsModal(true)}
      />

      <SettingsModal 
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
      />

      {editingField && (() => {
        const parts = editingField.split('.');
        const parentField = parts[0];
        const subField = parts[1];
        
        const parentDef = focus.focusState.workflowDef?.params?.find(p => p.name === parentField);
        const subDef = subField ? parentDef?.fields?.find(f => f.name === subField) : null;
        
        const type = subDef ? subDef.type : (parentDef?.type || 'string');
        const label = subDef ? subDef.description : (parentDef?.description || parentDef?.name);
        
        const initialValue = subField 
          ? focus.focusState.currentParams[parentField]?.[subField]
          : focus.focusState.currentParams[parentField];

        return (
          <FocusInputModal
            isOpen={!!editingField}
            field={editingField}
            label={label}
            type={type}
            initialValue={initialValue}
            onClose={() => setEditingField(null)}
            onSubmit={handleInputSubmit}
          />
        );
      })()}
      <input 
        type="file" 
        ref={fileInputRef} 
        style={{ display: 'none' }} 
        accept="image/*"
        onChange={handleFileChange}
      />

      <LoginRegisterModal 
        isOpen={showLoginRegister} 
        onClose={() => setShowLoginRegister(false)}
        onRegister={handleRegister}
        onLogin={async (name, pwd) => {
          try {
            await loginUser(name, pwd);
            setPendingRegData({ name, pwd, uid: 'temp' });
            setShowLoginRegister(false);
            setShowPinSetup(true);
          } catch (err: any) {
            // Handle AppErrors
            if (err instanceof AppError && err.code === ErrorCode.AUTH_FORBIDDEN) {
              setShowLoginRegister(false);
              const errorMsg: Message = {
                id: Date.now().toString(),
                type: "text",
                content: `抱歉，您的账号 "${name}" 暂时无法登录。\n\n原因：权限不足\n\n请联系管理员为您的账号分配相应的访问权限。`,
                sender: "system",
                timestamp: Date.now(),
              };
              setMessages(prev => [...prev, errorMsg]);
            } else {
              showError(err);
            }
          }
        }}
      />
      

      
      <PinPadModal
        isOpen={showPinSetup}
        mode="setup"
        onSuccess={handlePinSetupSuccess}
      />

      <PinPadModal
        isOpen={showPinLogin}
        mode="verify"
        onSuccess={handlePinLoginSuccess}
      />

      {showAccountSelector && (
        <AccountSelector
          savedAccountName={savedAccountName}
          onUseSavedAccount={handleUseSavedAccount}
          onUseOtherAccount={handleUseOtherAccount}
        />
      )}
    </>
  );
}

export default App;
