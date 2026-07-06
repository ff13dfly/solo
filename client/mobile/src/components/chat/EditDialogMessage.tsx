import type { Message } from "../../types";

interface EditDialogMessageProps {
  message: Message;
  onAction?: (action: string) => void;
}

export function EditDialogMessage({ message, onAction }: EditDialogMessageProps) {
  // Clicking this could open a modal store in App state.
  // For now, let's make it look like a card with an action.

  const title = message.payload?.title || "Edit Request";

  const buttonText = message.payload?.buttonText || "Check & Edit";

  return (
    <div 
      className="bg-white rounded-xl w-full shadow-sm overflow-hidden border border-blue-100 active:scale-[0.99] transition-transform cursor-pointer"
      onClick={() => onAction?.("open_modal")}
    >
      <div className="p-4 flex flex-col items-center justify-center space-y-3 bg-blue-50/50">
        <div className="text-center space-y-1">
          <h3 className="font-bold text-gray-900 text-lg">{title}</h3>
          <p className="text-sm text-gray-500">{message.content}</p>
        </div>
        
        <button 
          className="w-full bg-blue-600 text-white font-bold py-3 px-6 rounded-lg shadow-blue-200 shadow-md active:bg-blue-700 transition-all flex items-center justify-center gap-2"
        >
          {buttonText}
        </button>
      </div>
    </div>
  );
}
