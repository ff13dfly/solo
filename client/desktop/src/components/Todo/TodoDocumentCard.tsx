import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Trash2, Edit3, CheckSquare, Square } from "lucide-react";
import { PlannerTodo } from "./useTodoSync";
import { MarkdownRenderer } from "../UI/Markdown/MarkdownRenderer";
import { AdvancedColorPicker } from "../UI/AdvancedColorPicker";

interface TodoDocumentCardProps {
    todo: PlannerTodo;
    isInlineEditing: boolean;
    isSelected: boolean;
    onSelect: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onUpdate: (updates: Partial<PlannerTodo>) => void;
    onStartInlineEdit: () => void;
    onFinishInlineEdit: (title: string) => void;
}

export default function TodoDocumentCard({
    todo,
    isInlineEditing,
    isSelected,
    onSelect,
    onEdit,
    onDelete,
    onUpdate,
    onStartInlineEdit,
    onFinishInlineEdit
}: TodoDocumentCardProps) {
    const [tempTitle, setTempTitle] = useState(todo.title);
    const [colorPickerAnchor, setColorPickerAnchor] = useState<{ rect: DOMRect } | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Sync title from prop if modified elsewhere
    useEffect(() => {
        setTempTitle(todo.title);
    }, [todo.title]);

    // Focus and select text when entering inline edit mode
    useEffect(() => {
        if (isInlineEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isInlineEditing]);

    const toggleTodo = (e: React.MouseEvent) => {
        e.stopPropagation();
        onUpdate({ completed: !todo.completed });
    };

    const handleColorClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        setColorPickerAnchor({
            rect: e.currentTarget.getBoundingClientRect()
        });
    };

    const themeColor = todo.ext?.color || '#0071e3';

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            style={{ '--todo-accent': themeColor } as React.CSSProperties}
            className={`group relative rounded-2xl border cursor-pointer flex flex-col h-full overflow-hidden ${isSelected
                ? "bg-white border-transparent shadow-[0_32px_64px_-16px_rgba(0,113,227,0.22)] scale-[1.02] z-10"
                : todo.completed
                    ? "bg-black/[0.02] border-transparent opacity-60"
                    : "bg-white border-black/10 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.05)] hover:shadow-[0_32px_64px_-16px_rgba(0,113,227,0.15)] hover:scale-[1.02] hover:border-transparent"
                }`}
            onClick={(e) => {
                e.stopPropagation();
                onSelect();
            }}
        >
            <div
                className={`p-3 pb-1 flex items-center gap-2.5 h-14 relative ${isSelected ? "" : (!todo.completed ? 'backdrop-blur-md bg-white/80 border-b border-[#d2d2d7]/50' : 'bg-inherit')}`}
                style={{
                    background: isSelected
                        ? `linear-gradient(to right, ${todo.ext?.color || '#0071e3'}1A, transparent)`
                        : undefined
                }}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    onStartInlineEdit();
                }}
            >
                {/* Dynamic Header Gradient Preview on Hover */}
                {!isSelected && !todo.completed && (
                    <div
                        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                        style={{ background: `linear-gradient(to right, ${todo.ext?.color || '#0071e3'}0D, transparent)` }}
                    />
                )}

                {/* Vertical Ribbon Accent */}
                <div
                    className={`absolute left-0 top-1 bottom-1 w-[4px] rounded-r-full transition-transform duration-500 origin-left ${isSelected ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-50'}`}
                    style={{ backgroundColor: todo.ext?.color || '#0071e3' }}
                />

                <div
                    className={`shrink-0 flex items-center justify-center p-1 -m-1 rounded-md transition-colors ${isSelected ? 'hover:bg-black/5' : 'hover:bg-black/[0.05]'
                        }`}
                    onClick={toggleTodo}
                >
                    {todo.completed ? (
                        <CheckSquare size={20} className="text-[#32d74b]" />
                    ) : (
                        <Square
                            size={20}
                            className={isSelected ? "" : "text-[#d2d2d7] group-hover:text-[var(--todo-accent)] transition-colors"}
                            style={isSelected ? { color: themeColor } : {}}
                        />
                    )}
                </div>

                <div className="flex-1 min-w-0">
                    {isInlineEditing ? (
                        <input
                            ref={inputRef}
                            className={`text-lg font-bold outline-none border-none bg-transparent w-full ${!isSelected ? "text-[#1d1d1f]" : ""}`}
                            style={isSelected ? { color: todo.ext?.color || '#0071e3' } : {}}
                            value={tempTitle}
                            placeholder="Untitled note"
                            onChange={(e) => setTempTitle(e.target.value)}
                            onBlur={() => onFinishInlineEdit(tempTitle)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') onFinishInlineEdit(tempTitle);
                                if (e.key === 'Escape') {
                                    setTempTitle(todo.title);
                                    onFinishInlineEdit(todo.title);
                                }
                            }}
                            onClick={(e) => e.stopPropagation()}
                        />
                    ) : (
                        <h4
                            className={`text-lg font-bold leading-tight line-clamp-1 break-all transition-colors pr-2 ${!isSelected
                                ? todo.completed
                                    ? "line-through text-[#86868b]"
                                    : "text-[#1d1d1f] group-hover:text-[var(--todo-accent)]"
                                : ""}`}
                            style={isSelected ? { color: themeColor } : {}}
                        >
                            {todo.title}
                        </h4>
                    )}
                </div>

                {!isInlineEditing && !todo.completed && (
                    <div
                        className={`shrink-0 w-3 h-3 rounded-md shadow-sm border transition-transform cursor-pointer hover:scale-125 ${isSelected ? "border-black/10" : "border-black/5"
                            }`}
                        style={{ backgroundColor: todo.ext?.color || '#0071e3' }}
                        onClick={handleColorClick}
                    />
                )}
                {!isInlineEditing && todo.pinned && !todo.completed && (
                    <Sparkles
                        size={14}
                        className="shrink-0 mt-0.5"
                        style={isSelected ? { color: themeColor } : { color: '#ff9f0a' }}
                    />
                )}
            </div>

            <div className={`flex-1 px-3 overflow-hidden relative ${todo.completed ? 'opacity-40' : ''}`}>
                <div className="py-1">
                    <MarkdownRenderer
                        content={todo.content.split('\n').filter(line => !line.startsWith('# ')).slice(0, 15).join('\n')}
                        itemClassName="text-[11px] leading-snug text-[#424245]"
                    />
                </div>
                <div className={`absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t to-transparent ${todo.completed ? 'from-[#f5f5f7]' : 'from-white'}`} />
            </div>

            <div className="p-3 pt-1 mt-auto flex items-center justify-between">
                <div className="flex gap-2">
                    {todo.tags?.slice(0, 2).map(tag => (
                        <span key={tag} className="text-[8px] font-black text-[#86868b] bg-[#f5f5f7] px-2 py-0.5 rounded-full">
                            {tag.toUpperCase()}
                        </span>
                    ))}
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={(e) => { e.stopPropagation(); onDelete(); }}
                        className="w-8 h-8 rounded-full bg-red-50 flex items-center justify-center text-red-500 opacity-0 group-hover:opacity-100 translate-x-2 group-hover:translate-x-0 transition-all hover:bg-red-500 hover:text-white"
                    >
                        <Trash2 size={14} />
                    </button>
                    {!todo.completed && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onEdit(); }}
                            className="w-8 h-8 rounded-full bg-[#f5f5f7] flex items-center justify-center text-[#86868b] opacity-0 group-hover:opacity-100 translate-x-2 group-hover:translate-x-0 transition-all shadow-sm border border-black/5 hover:bg-[#0071e3] hover:text-white"
                        >
                            <Edit3 size={14} />
                        </button>
                    )}
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

            <div
                className={`absolute bottom-0 left-0 right-0 h-1 transition-transform duration-300 origin-left scale-x-0 ${!todo.completed ? "group-hover:scale-x-100" : ""}`}
                style={{ backgroundColor: todo.ext?.color || '#0071e3' }}
            />
        </motion.div>
    );
}
