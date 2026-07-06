import type { ReactNode } from "react";
import { MessageList } from "./MessageList";
import { InputBar } from "./InputBar";
import { Settings } from "lucide-react";
import type { Message } from "../../types";
import { isSimulator } from "../../lib/simulator-patch";


interface ChatLayoutProps {
  messages: Message[];
  onSendMessage: (content: string, type: "text" | "voice" | "image" | "file") => void;
  title?: string;
  onTitleClick?: () => void;
  onAction?: (action: string, message: Message) => void;
  userAvatar?: string;
  onUserAvatarClick?: () => void;
  focusCard?: ReactNode;
  currentTheme?: 'light' | 'dark' | 'ocean' | 'forest';
  onToggleTheme?: () => void;
  onSettingsClick?: () => void;
}

export function ChatLayout({ 
  messages, 
  onSendMessage, 
  title = "WeChat", 
  onTitleClick, 
  onAction, 
  userAvatar, 
  onUserAvatarClick, 
  focusCard,
  onSettingsClick
}: ChatLayoutProps) {
  const inSimulator = isSimulator();
  
  return (
    <div className="flex flex-col h-screen w-full bg-gray-100 relative overflow-hidden transition-colors duration-300">
      {/* Header */}
      <header className="h-[44px] sm:h-[50px] bg-white border-b border-gray-100 flex items-center justify-between px-4 sticky top-0 z-10 transition-colors duration-300">
        <div className="flex items-center text-black w-8">
          {/* Arrow Removed */}
        </div>
        
        <div 
          className="flex flex-col items-center cursor-pointer active:opacity-50 select-none"
          onClick={onTitleClick}
        >
          <div className="font-semibold text-[17px]">{title}</div>
          {inSimulator && (
            <div className="text-[10px] text-[#58a6ff] font-medium leading-none mt-0.5 px-1.5 py-0.5 bg-[#58a6ff1a] border border-[#58a6ff33] rounded-full uppercase tracking-wider">
              Simulator
            </div>
          )}
        </div>
        
        <div className="w-8 flex justify-end">
          <button 
            className="p-1 rounded-full text-gray-500 hover:bg-gray-100 active:bg-gray-200 transition-colors"
            onClick={onSettingsClick}
          >
            <Settings size={22} />
          </button>
        </div>
      </header>

      {/* Main Content - Pass focusCard to MessageList for inline rendering */}
      <MessageList 
        messages={messages} 
        onAction={onAction} 
        userAvatar={userAvatar}
        onUserAvatarClick={onUserAvatarClick}
        focusCard={focusCard}
      />

      {/* Input Area */}
      <InputBar onSendMessage={onSendMessage} />
    </div>
  );
}
