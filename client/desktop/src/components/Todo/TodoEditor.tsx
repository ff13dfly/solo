import React, { useState, useEffect, useRef } from "react";
import { ChevronLeft } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { PlannerTodo } from "./useTodoSync";
import { MarkdownRenderer } from "../UI/Markdown/MarkdownRenderer";
import { AdvancedColorPicker } from "../UI/AdvancedColorPicker";

interface TodoEditorProps {
    todo: PlannerTodo;
    onClose: () => void;
    onUpdate: (updates: Partial<PlannerTodo>) => void;
    titleRef: React.RefObject<HTMLInputElement> | null;
}

export default function TodoEditor({ todo, onClose, onUpdate }: TodoEditorProps) {
    const [title, setTitle] = useState(todo.title);
    const [content, setContent] = useState(todo.content);
    const [colorPickerAnchor, setColorPickerAnchor] = useState<{ rect: DOMRect } | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Sync state to parent on change
    useEffect(() => {
        onUpdate({ title, content });
    }, [title, content, onUpdate]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const textarea = e.currentTarget;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;

            // Insert 4 spaces
            const newValue = content.substring(0, start) + "    " + content.substring(end);
            setContent(newValue);

            // Restore cursor position after render
            setTimeout(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 4;
                }
            }, 0);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="absolute inset-0 z-50 bg-white border-t border-[#f2f2f7] overflow-hidden flex flex-col"
        >
            {/* Glossy Header */}
            <header className="flex items-center justify-between px-8 py-4 bg-white/50 backdrop-blur-md border-b border-[#f2f2f7] shrink-0">
                <div className="flex items-center gap-4">
                    <button
                        onClick={onClose}
                        className="px-5 py-2 bg-[#0071e3] text-white rounded-full font-bold text-xs shadow-lg shadow-blue-500/20 hover:scale-105 transition-all flex items-center gap-2"
                    >
                        <ChevronLeft size={16} strokeWidth={3} />
                        Done
                    </button>
                </div>

                <div className="flex items-center gap-3">
                    <span className="text-[10px] font-black text-[#86868b] uppercase tracking-widest bg-[#f5f5f7] px-3 py-1 rounded-full border border-black/5 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                        SPLIT VIEW
                    </span>
                    <span className="text-[10px] font-black text-[#86868b] uppercase tracking-widest bg-[#f5f5f7] px-3 py-1 rounded-full border border-black/5">
                        {content.length} CHARS
                    </span>
                </div>
            </header>

            <div className="flex-1 flex overflow-hidden">
                {/* Editor Pane (Left) */}
                <div className="flex-1 flex flex-col p-8 pt-10 overflow-y-auto no-scrollbar border-r border-[#f2f2f7]">
                    {/* Title Section */}
                    <div className="relative flex items-center mb-6 shrink-0 group">
                        <button
                            onClick={(e) => setColorPickerAnchor({ rect: e.currentTarget.getBoundingClientRect() })}
                            className="absolute -left-6 top-3 w-3 h-3 rounded-full shadow-sm border border-black/10 hover:scale-125 transition-transform"
                            style={{ backgroundColor: todo.ext?.color || '#0071e3' }}
                        />
                        <input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            className="w-full text-3xl font-bold bg-transparent outline-none border-none placeholder:text-black/20 text-[#1d1d1f]"
                            placeholder="Untitled"
                        />
                    </div>

                    <textarea
                        ref={textareaRef}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        onKeyDown={handleKeyDown}
                        className="w-full flex-1 outline-none border-none bg-transparent font-mono text-base leading-relaxed text-[#1d1d1f] resize-none pb-40"
                        placeholder="Start writing..."
                    />
                </div>

                {/* Preview Pane (Right) */}
                <div className="flex-1 p-8 pt-10 overflow-y-auto no-scrollbar bg-[#fbfbfd]">
                    <div className="max-w-prose mx-auto space-y-8">
                        {/* Title Preview */}
                        <h1 className="text-3xl font-bold text-[#1d1d1f] border-b border-[#00000010] pb-4">
                            {title || 'Untitled'}
                        </h1>
                        <MarkdownRenderer content={content} />
                    </div>
                </div>
            </div>

            <AnimatePresence>
                {colorPickerAnchor && (
                    <AdvancedColorPicker
                        anchorRect={colorPickerAnchor.rect}
                        currentColor={todo.ext?.color}
                        onClose={() => setColorPickerAnchor(null)}
                        onSelect={(color) => {
                            onUpdate({
                                ext: {
                                    ...(todo.ext || {}),
                                    color
                                }
                            });
                        }}
                    />
                )}
            </AnimatePresence>
        </motion.div>
    );
}
