import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Upload } from "lucide-react";
import { useI18n } from "../../i18n/I18nProvider";
import { AIAssistantProps } from "./AIAssistant/AIAssistantTypes";
import { useAIAssistant } from "./AIAssistant/useAIAssistant";
import { ProcessingPanel } from "./AIAssistant/ProcessingPanel";
import { ChatArea } from "./AIAssistant/ChatArea";
import { ControlArea } from "./AIAssistant/ControlArea";

export default function TodoAIAssistant({
    onManualAdd,
    onUploadFile,
    selectedTodo,
    onDeselectTodo
}: AIAssistantProps) {
    const { t } = useI18n();
    const { state, actions, fileInputRef } = useAIAssistant();

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            onUploadFile(file);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    return (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-full max-w-4xl px-4 z-20">
            <motion.div
                layout
                initial={{ y: 100, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ type: "spring", damping: 25, stiffness: 200 }}
                className="bg-white/90 backdrop-blur-2xl border border-[#d2d2d7] rounded-3xl shadow-2xl p-4 flex items-stretch gap-4"
            >
                <AnimatePresence mode="wait" initial={false}>
                    {state.isProcessing && <ProcessingPanel />}

                    <motion.div
                        key="chat-group"
                        layout
                        className="flex flex-col gap-3 min-w-0"
                        style={{ flex: state.isProcessing ? "0 0 120px" : "1 1 auto" }}
                    >
                        <ChatArea
                            prompt={state.prompt}
                            setPrompt={actions.setPrompt}
                            isHidingInput={state.isHidingInput}
                            isProcessing={state.isProcessing}
                            selectedTodo={selectedTodo}
                            onGenerate={actions.handleGenerate}
                            onExitComplete={actions.startProcessing}
                        />

                        <ControlArea
                            isProcessing={state.isProcessing}
                            isHidingInput={state.isHidingInput}
                            selectedModel={state.selectedModel}
                            isModelOpen={state.isModelOpen}
                            setIsModelOpen={actions.setIsModelOpen}
                            setSelectedModel={actions.setSelectedModel}
                            isAutoUpdate={state.isAutoUpdate}
                            setIsAutoUpdate={actions.setIsAutoUpdate}
                            selectedTodo={selectedTodo}
                            onDeselectTodo={onDeselectTodo}
                            onGenerate={actions.handleGenerate}
                            prompt={state.prompt}
                        />
                    </motion.div>
                </AnimatePresence>

                {/* Vertical Separator */}
                {!state.isHidingInput && !state.isProcessing && <div className="w-[1px] bg-[#d2d2d7] my-1 shrink-0 hidden sm:block" />}

                {/* Action Group (Right Column) */}
                {!state.isHidingInput && !state.isProcessing && (
                    <div className="flex-col justify-center gap-2.5 py-0.5 shrink-0 hidden sm:flex">
                        <button
                            onClick={onManualAdd}
                            title={t('todo.manual_add') || "Manual Add"}
                            className="w-9 h-9 flex items-center justify-center bg-[#f5f5f7] hover:bg-[#e8e8ed] text-[#1d1d1f] rounded-xl transition-all active:scale-95 border border-[#d2d2d7]/50"
                        >
                            <Plus size={18} />
                        </button>

                        <button
                            onClick={() => fileInputRef.current?.click()}
                            title={t('todo.upload_markdown') || "Upload Markdown"}
                            className="w-9 h-9 flex items-center justify-center bg-[#f5f5f7] hover:bg-[#e8e8ed] text-[#1d1d1f] rounded-xl transition-all active:scale-95 border border-[#d2d2d7]/50"
                        >
                            <Upload size={18} />
                        </button>

                        <input
                            type="file"
                            ref={fileInputRef}
                            className="hidden"
                            accept=".md,.markdown,text/markdown"
                            onChange={handleFileChange}
                        />
                    </div>
                )}
            </motion.div>
        </div>
    );
}
