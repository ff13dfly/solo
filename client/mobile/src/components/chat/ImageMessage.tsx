import { cn } from "../../lib/utils";
import type { Message } from "../../types";

interface ImageMessageProps {
  message: Message;
}

export function ImageMessage({ message }: ImageMessageProps) {
  return (
    <div className={cn("max-w-[70%] rounded-lg overflow-hidden bg-white relative")}>
      {/* If it's a blob url or remote url */}
      <img 
        src={message.content} 
        alt="User sent" 
        className="w-full h-auto max-h-[200px] object-cover"
        loading="lazy"
      />
    </div>
  );
}
