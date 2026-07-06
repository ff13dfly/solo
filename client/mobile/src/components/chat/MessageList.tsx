import { useRef, useEffect, type ReactNode } from "react";
import type { Message } from "../../types";
import { cn } from "../../lib/utils";
import { TextMessage } from "./TextMessage";
import { ImageMessage } from "./ImageMessage";
import { ChartMessage } from "./ChartMessage";
import { EditDialogMessage } from "./EditDialogMessage";
import { ListMessage } from "./ListMessage";

interface MessageListProps {
  messages: Message[];
  onAction?: (action: string, message: Message) => void;
  userAvatar?: string;
  onUserAvatarClick?: () => void;
  focusCard?: ReactNode;
}

export function MessageList({ messages, onAction, userAvatar, onUserAvatarClick, focusCard }: MessageListProps) {

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Find if there's a focus_response message (indicates Focus mode is active)
  const hasFocusResponse = messages.some(msg => msg.id === 'focus_response');

  return (
    <div 
      className="flex-1 overflow-y-auto bg-[#ededed] p-4 space-y-4"
      ref={scrollRef}
    >
      {messages.map((msg, index) => (
        <div key={msg.id}>
          {/* Render the message */}
          <div
            className={cn(
              "flex w-full",
              msg.sender === "user" ? "justify-end" : "justify-start"
            )}
          >
            {/* Avatar */}
            {msg.sender === "system" && msg.type !== "edit_dialog" && (
              <img src={`${import.meta.env.BASE_URL}icon.png`} alt="AI" className="w-10 h-10 rounded-md mr-2 flex-shrink-0 object-contain bg-white" />
            )}

            {msg.type === "text" && <TextMessage message={msg} />}
            {msg.type === "voice" && <TextMessage message={msg} />}
            {msg.type === "file" && <TextMessage message={msg} />}
            {msg.type === "image" && <ImageMessage message={msg} />}
            {msg.type === "chart" && <ChartMessage message={msg} />}
            {msg.type === "edit_dialog" && (
              <EditDialogMessage
                message={msg}
                onAction={(action) => onAction?.(action, msg)}
              />
            )}
            {msg.type === "list" && <ListMessage message={msg} />}

            {msg.sender === "user" && (
              <div 
                className="w-10 h-10 bg-white border border-gray-200 rounded-md ml-2 flex-shrink-0 overflow-hidden cursor-pointer active:opacity-80 transition-opacity flex items-center justify-center"
                onClick={onUserAvatarClick}
              >
                {userAvatar ? (
                  <img src={userAvatar} alt="User" className="w-full h-full object-cover" />
                ) : (
                  <svg viewBox="0 0 24 24" className="w-6 h-6 text-gray-400" fill="currentColor">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                  </svg>
                )}
              </div>
            )}
          </div>

          {/* Insert Focus Card after the user's trigger message (message before focus_response) */}
          {focusCard && hasFocusResponse && messages[index + 1]?.id === 'focus_response' && (
            <div className="my-4">
              {focusCard}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
