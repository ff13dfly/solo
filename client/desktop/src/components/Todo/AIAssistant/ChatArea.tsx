import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PlannerTodo } from "../useTodoSync";
import { useI18n } from "../../../i18n/I18nProvider";

interface ChatAreaProps {
    prompt: string;
    setPrompt: (val: string) => void;
    isHidingInput: boolean;
    isProcessing: boolean;
    selectedTodo?: PlannerTodo;
    onGenerate: () => void;
    onExitComplete: () => void;
}

export function ChatArea({
    prompt,
    setPrompt,
    isHidingInput,
    isProcessing,
    selectedTodo,
    onGenerate,
    onExitComplete
}: ChatAreaProps) {
    const { t } = useI18n();

    return (
        <AnimatePresence mode="wait" onExitComplete={onExitComplete}>
            {isHidingInput || isProcessing ? (
                <motion.div
                    key="processing-top"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="h-[44px] flex items-center justify-center"
                >
                    {isProcessing && selectedTodo && (
                        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#0071e3]/30 rounded-xl shadow-[0_2px_8px_-2px_rgba(0,113,227,0.15)] max-w-full overflow-hidden">
                            <span className="text-[10px] font-bold text-[#0071e3] truncate">
                                # {selectedTodo.title}
                            </span>
                        </div>
                    )}
                </motion.div>
            ) : (
                <motion.div
                    key="chat-input"
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
                    className="relative flex items-center bg-[#f5f5f7] border border-[#d2d2d7] rounded-2xl focus-within:ring-2 focus-within:ring-[#0071e3]/20 focus-within:border-[#0071e3]/40 transition-colors duration-200 outline-none shadow-none"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                    <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder={t('todo.ai_prompt_placeholder') || "Describe your goals, and I'll plan tasks for you..."}
                        className="flex-1 min-h-[44px] max-h-32 px-4 py-3 bg-transparent border-none text-sm focus:ring-0 focus:outline-none focus:ring-inset transition-colors resize-none no-scrollbar font-normal appearance-none shadow-none"
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                onGenerate();
                            }
                        }}
                    />
                </motion.div>
            )}
        </AnimatePresence>
    );
}
