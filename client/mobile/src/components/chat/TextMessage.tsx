import { cn } from "../../lib/utils";
import type { Message } from "../../types";

interface TextMessageProps {
  message: Message;
}

export function TextMessage({ message }: TextMessageProps) {
  return (
    <div
      className={cn(
        "max-w-[70%] rounded-lg p-3 text-sm leading-relaxed relative break-words",
        message.sender === "user" 
          ? "bg-[#95ec69] text-black" 
          : "bg-white text-black"
      )}
    >
      {/* Triangle for bubble effect */}
      <div
        className={cn(
          "absolute top-3 w-0 h-0 border-[6px] border-transparent",
          message.sender === "user"
            ? "right-[-6px] border-l-[#95ec69]"
            : "left-[-6px] border-r-white"
        )}
      />
      {message.content}
    </div>
  );
}
