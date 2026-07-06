export type MessageType = "text" | "image" | "voice" | "chart" | "edit_dialog" | "file" | "list";

export interface Message {
  id: string;
  type: MessageType;
  content: string; // Text content, or URL for image, or JSON data for chart/dialog
  sender: "user" | "system";
  timestamp: number;
  payload?: any; // For chart data or complex objects
}
