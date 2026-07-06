import React, { useState, useRef } from "react";
import { Mic, Keyboard, Image as ImageIcon } from "lucide-react";
import { callAgent } from "../../lib/api";

interface InputBarProps {
  onSendMessage: (content: string, type: "text" | "voice" | "image" | "file") => void;
}

// Speech → text is an INPUT concern, handled here: record → agent.audio.transcribe (Qwen) →
// feed the transcript through the normal text pipeline. No "voice" message type reaches the
// chat logic, so transcription failures stay local (retry) instead of polluting the conversation.
type VoiceState = "idle" | "recording" | "transcribing";

export function InputBar({ onSendMessage }: InputBarProps) {
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const handleSend = () => {
    if (inputValue.trim()) {
      onSendMessage(inputValue, "text");
      setInputValue("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ---- Voice: record → transcribe (Qwen) → send as text ----------------------

  const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        // FileReader gives "data:<mime>;base64,<data>" — strip to raw base64 for agent.audio.transcribe
        const out = (reader.result as string) || "";
        resolve(out.includes(",") ? out.split(",")[1] : out);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

  const releaseMic = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const handleVoiceStart = async (e: React.SyntheticEvent) => {
    e.preventDefault(); // also suppresses the long-press context menu
    if (voiceState !== "idle") return;
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (ev) => { if (ev.data.size > 0) chunksRef.current.push(ev.data); };
      recorder.onstop = handleRecordingStop;
      recorderRef.current = recorder;
      recorder.start();
      setVoiceState("recording");
    } catch (err) {
      console.error("[Voice] microphone access failed:", err);
      setVoiceError("无法访问麦克风，请检查权限");
      releaseMic();
    }
  };

  const handleVoiceEnd = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (voiceState !== "recording") return;
    recorderRef.current?.stop(); // → onstop → handleRecordingStop
  };

  const handleRecordingStop = async () => {
    const recorder = recorderRef.current;
    releaseMic();
    const mimeType = recorder?.mimeType || chunksRef.current[0]?.type || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    if (blob.size === 0) { setVoiceState("idle"); return; }

    setVoiceState("transcribing");
    try {
      const base64 = await blobToBase64(blob);
      // Qwen audio path: provider auto-detected from the "qwen-" model prefix.
      const res = await callAgent<{ success?: boolean; text?: string }>("agent.audio.transcribe", {
        audio: base64,
        mimeType,
        model: "qwen-audio-turbo",
      });
      const text = (res?.text || "").trim();
      if (text) {
        onSendMessage(text, "text");
      } else {
        setVoiceError("没听清，请再说一次");
      }
    } catch (err: any) {
      console.error("[Voice] transcription failed:", err);
      setVoiceError(err?.message || "识别失败，请重试");
    } finally {
      setVoiceState("idle");
    }
  };

  const voiceLabel =
    voiceState === "recording" ? "松开发送" : voiceState === "transcribing" ? "识别中…" : "按住说话";

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      onSendMessage(url, "image");
    }
    if (imageInputRef.current) imageInputRef.current.value = "";
  };

  return (
    <div className="flex flex-col gap-1 p-2 bg-[#f7f7f7] border-t border-gray-200">
      <div className="flex items-end gap-2">
        {/* Voice/Keyboard Toggle */}
        <button
          onClick={() => setIsVoiceMode(!isVoiceMode)}
          className="p-2 text-gray-600 hover:bg-gray-200 rounded-full transition-colors"
        >
          {isVoiceMode ? <Keyboard size={24} /> : <Mic size={24} />}
        </button>

        {/* Input Area */}
        <div className="flex-1 min-h-[40px] flex items-center">
          {isVoiceMode ? (
            <button
              data-test="voice-hold"
              disabled={voiceState === "transcribing"}
              className={`w-full h-10 bg-white border rounded-md font-medium select-none touch-none transition-colors
                ${voiceState === "recording" ? "border-green-500 bg-green-50 text-green-700" : "border-gray-300 text-gray-700 active:bg-gray-200"}
                ${voiceState === "transcribing" ? "opacity-60" : ""}`}
              onContextMenu={(e) => e.preventDefault()}
              onMouseDown={handleVoiceStart}
              onMouseUp={handleVoiceEnd}
              onMouseLeave={handleVoiceEnd}
              onTouchStart={handleVoiceStart}
              onTouchEnd={handleVoiceEnd}
            >
              {voiceLabel}
            </button>
          ) : (
            <textarea
              data-test="chat-input"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full max-h-32 py-2 px-3 bg-white border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-green-500 resize-none text-base"
              rows={1}
              placeholder=""
            />
          )}
        </div>

        {/* Image Upload Button */}
        <button
          className="p-2 text-gray-600 hover:bg-gray-200 rounded-full transition-colors"
          onClick={() => imageInputRef.current?.click()}
        >
          <ImageIcon size={24} />
        </button>

        {/* Hidden Inputs */}
        <input
          type="file"
          className="hidden"
          ref={imageInputRef}
          accept="image/*,.png,.jpg,.jpeg,.webp,.gif"
          onChange={handleImageUpload}
        />
      </div>

      {voiceError && <p className="px-2 text-xs text-red-500">{voiceError}</p>}
    </div>
  );
}
