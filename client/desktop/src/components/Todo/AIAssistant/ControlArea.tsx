import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Loader2, ChevronDown, X } from "lucide-react";
import { useI18n } from "../../../i18n/I18nProvider";
import { AIModel } from "./AIAssistantTypes";
import { PlannerTodo } from "../useTodoSync";
import { MODELS } from "./useAIAssistant";

interface ControlAreaProps {
    isProcessing: boolean;
    isHidingInput: boolean;
    selectedModel: AIModel;
    isModelOpen: boolean;
    setIsModelOpen: (open: boolean) => void;
    setSelectedModel: (model: AIModel) => void;
    isAutoUpdate: boolean;
    setIsAutoUpdate: (val: boolean) => void;
    selectedTodo?: PlannerTodo;
    onDeselectTodo: () => void;
    onGenerate: () => void;
    prompt: string;
}

export function ControlArea({
    isProcessing,
    isHidingInput,
    selectedModel,
    isModelOpen,
    setIsModelOpen,
    setSelectedModel,
    isAutoUpdate,
    setIsAutoUpdate,
    selectedTodo,
    onDeselectTodo,
    onGenerate,
    prompt
}: ControlAreaProps) {
    const { t, locale } = useI18n();

    return (
        <div className="flex items-center justify-between px-0.5 h-9">
            {!isHidingInput && !isProcessing && (
                <div className="flex items-center gap-2">
                    <div className="relative shrink-0">
                        <button
                            onClick={() => setIsModelOpen(!isModelOpen)}
                            className="flex items-center justify-between w-[130px] px-3 py-1.5 bg-[#f5f5f7] hover:bg-[#e8e8ed] rounded-xl transition-colors text-[11px] font-bold text-[#1d1d1f] border border-[#d2d2d7]/50"
                        >
                            <div className="flex items-center gap-1.5 min-w-0">
                                <Sparkles size={12} className="text-[#0071e3] shrink-0" />
                                <span className="truncate">{selectedModel.name}</span>
                            </div>
                            <ChevronDown size={12} className={`shrink-0 transition-transform duration-200 ${isModelOpen ? 'rotate-180' : ''}`} />
                        </button>

                        <AnimatePresence>
                            {isModelOpen && (
                                <>
                                    <div className="fixed inset-0 z-30" onClick={() => setIsModelOpen(false)} />
                                    <motion.div
                                        initial={{ opacity: 0, y: 10, scale: 0.95 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                                        className="absolute bottom-full left-0 mb-2 w-48 bg-white/95 backdrop-blur-xl border border-[#d2d2d7] rounded-2xl shadow-xl overflow-hidden z-40 p-1"
                                    >
                                        {MODELS.map((model) => (
                                            <button
                                                key={model.id}
                                                onClick={() => {
                                                    setSelectedModel(model);
                                                    setIsModelOpen(false);
                                                }}
                                                className={`w-full text-left px-3 py-2 rounded-xl text-[11px] font-medium transition-colors ${selectedModel.id === model.id ? 'bg-[#0071e3] text-white' : 'hover:bg-[#f5f5f7] text-[#1d1d1f]'}`}
                                            >
                                                {model.name}
                                            </button>
                                        ))}
                                    </motion.div>
                                </>
                            )}
                        </AnimatePresence>
                    </div>

                    {/* AI Auto-Update Toggle */}
                    <div className="flex flex-col items-center gap-0.5 shrink-0">
                        <button
                            onClick={() => setIsAutoUpdate(!isAutoUpdate)}
                            className={`w-7 h-4 rounded-full p-0.5 transition-colors duration-200 ${isAutoUpdate ? 'bg-[#32d74b]' : 'bg-[#d2d2d7]'}`}
                        >
                            <motion.div
                                animate={{ x: isAutoUpdate ? 12 : 0 }}
                                className="w-3 h-3 bg-white rounded-full shadow-sm"
                            />
                        </button>
                        <span className="text-[8px] font-black text-[#86868b] uppercase tracking-tighter opacity-80">{t('todo.overwrite')}</span>
                    </div>

                    {selectedTodo && (
                        <motion.div
                            initial={{ opacity: 0, x: 10 }}
                            animate={{ opacity: 1, x: 0 }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#0071e3]/30 rounded-xl shadow-[0_2px_8px_-2px_rgba(0,113,227,0.15)] max-w-[120px] ml-4"
                        >
                            <span className="text-[11px] font-bold text-[#0071e3] truncate">
                                # {selectedTodo.title}
                            </span>
                            <button
                                onClick={onDeselectTodo}
                                className="p-1 hover:bg-[#0071e3]/10 rounded-lg transition-colors text-[#0071e3] flex-shrink-0"
                            >
                                <X size={12} strokeWidth={2.5} />
                            </button>
                        </motion.div>
                    )}
                </div>
            )
            }

            {/* Send Button */}
            <button
                onClick={onGenerate}
                disabled={isProcessing || isHidingInput || !prompt.trim()}
                className={`flex items-center justify-center gap-1.5 px-4 h-full rounded-xl transition-all font-bold text-[11px] ${isProcessing || isHidingInput || !prompt.trim()
                    ? isProcessing || isHidingInput
                        ? 'bg-[#0071e3] text-white w-full'
                        : 'bg-[#f5f5f7] text-[#86868b] border border-[#d2d2d7]/50 cursor-not-allowed'
                    : 'bg-[#0071e3] text-white shadow-[0_4px_12px_-2px_rgba(0,113,227,0.3)] hover:scale-105 active:scale-95'
                    }`}
            >
                {isProcessing || isHidingInput ? (
                    <Loader2 size={12} className="animate-spin" />
                ) : (
                    <Sparkles size={12} />
                )}
                <span className="hidden sm:inline">{isProcessing || isHidingInput ? (locale === 'zh' ? '运行中' : 'Running') : (locale === 'zh' ? '发送' : 'Send')}</span>
            </button>
        </div >
    );
}
