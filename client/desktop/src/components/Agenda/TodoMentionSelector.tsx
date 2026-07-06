import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckSquare, X } from 'lucide-react';
import { PlannerTodo } from '../Todo/useTodoSync';

interface TodoMentionSelectorProps {
    todos: PlannerTodo[];
    searchTerm: string;
    onSelect: (todo: PlannerTodo | null) => void;
    onClose: () => void;
    anchorRect: DOMRect | null;
    showClear?: boolean;
    maxRight?: number;
}

export const TodoMentionSelector: React.FC<TodoMentionSelectorProps> = ({
    todos,
    searchTerm,
    onSelect,
    onClose,
    anchorRect,
    showClear = false,
    maxRight
}) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);

    const filteredTodos = todos.filter(todo =>
        todo.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        todo.content.toLowerCase().includes(searchTerm.toLowerCase())
    ).slice(0, 8);

    const totalItems = filteredTodos.length + (showClear ? 1 : 0);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex(prev => (prev + 1) % Math.max(1, totalItems));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex(prev => (prev - 1 + totalItems) % Math.max(1, totalItems));
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (showClear && selectedIndex === 0) {
                    onSelect(null);
                } else {
                    const todoIdx = showClear ? selectedIndex - 1 : selectedIndex;
                    if (filteredTodos[todoIdx]) onSelect(filteredTodos[todoIdx]);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
    }, [totalItems, selectedIndex, filteredTodos, onSelect, onClose, showClear]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // Keep for accessibility if needed, but primary is global
    };

    if (!anchorRect) return null;

    const POPOVER_WIDTH = 256; // w-64
    const SCREEN_PADDING = 16;

    // Estimate actual height: items * ~38px + padding + border
    const itemHeight = 38;
    const paddingHeight = 12;
    const estimatedHeight = Math.min(256, totalItems * itemHeight + paddingHeight);

    let left = anchorRect.left;
    let top = anchorRect.bottom + 8;

    const boundaryRight = maxRight ?? (window.innerWidth - 320);

    // Horizontal Adjustment
    if (left + POPOVER_WIDTH > boundaryRight) {
        left = anchorRect.right - POPOVER_WIDTH;
    }

    if (left < SCREEN_PADDING) left = SCREEN_PADDING;
    if (left + POPOVER_WIDTH > window.innerWidth - SCREEN_PADDING) {
        left = window.innerWidth - POPOVER_WIDTH - SCREEN_PADDING;
    }

    // Vertical Adjustment
    if (top + estimatedHeight > window.innerHeight - SCREEN_PADDING) {
        const topAbove = anchorRect.top - 8 - estimatedHeight;
        if (topAbove > SCREEN_PADDING) {
            top = topAbove;
        }
    }

    return (
        <>
            <div className="fixed inset-0 z-[90]" onMouseDown={(e) => { e.preventDefault(); onClose(); }} />
            <div
                className="fixed z-[100] w-64 bg-white rounded-xl shadow-2xl border border-black/5 overflow-hidden flex flex-col items-stretch outline-none"
                style={{ top, left }}
                onKeyDown={handleKeyDown}
                onMouseDown={(e) => e.preventDefault()}
            >
                <div ref={scrollRef} className="max-h-64 overflow-y-auto p-1 py-1.5 no-scrollbar">
                    {showClear && (
                        <div
                            className={`group px-3 py-2 rounded-lg cursor-pointer flex items-center gap-3 transition-colors ${selectedIndex === 0 ? 'bg-[#f5f5f7]' : 'hover:bg-[#f5f5f7]'}`}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                onSelect(null);
                            }}
                            onMouseEnter={() => setSelectedIndex(0)}
                        >
                            <div className={`w-3.5 h-3.5 flex items-center justify-center`}>
                                <X size={14} className="text-[#ff3b30]" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className={`text-sm font-medium truncate text-[#ff3b30]`}>
                                    None / Remove Link
                                </div>
                            </div>
                        </div>
                    )}
                    {filteredTodos.map((todo, idx) => {
                        const itemIdx = showClear ? idx + 1 : idx;
                        const isSelected = itemIdx === selectedIndex;
                        return (
                            <div
                                key={todo.id}
                                className={`group px-3 py-2 rounded-lg cursor-pointer flex items-center gap-3 transition-colors ${isSelected ? 'bg-[#0071e3] text-white' : 'hover:bg-black/[0.03]'}`}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    onSelect(todo);
                                }}
                                onMouseEnter={() => setSelectedIndex(itemIdx)}
                            >
                                <CheckSquare size={14} className={isSelected ? 'text-white' : 'text-[#0071e3]'} />
                                <div className="flex-1 min-w-0">
                                    <div className={`text-sm font-medium truncate ${isSelected ? 'text-white' : 'text-[#1d1d1f]'}`}>
                                        {todo.title}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    {!showClear && filteredTodos.length === 0 && (
                        <div className="px-3 py-4 text-center text-[#86868b] text-xs">
                            No matches found
                        </div>
                    )}
                </div>
            </div>
        </>
    );
};
