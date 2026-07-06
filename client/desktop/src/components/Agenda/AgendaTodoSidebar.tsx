import React from "react";
import { CheckSquare, Square, ListTodo, Clock, Tag, ChevronRight, Hash } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useI18n } from "../../i18n/I18nProvider";
import { ViewType, AgendaEvent } from "./AgendaTypes";
import { PlannerTodo } from "../Todo/useTodoSync";
import { MarkdownRenderer } from "../UI/Markdown/MarkdownRenderer";
import { AdvancedColorPicker } from "../UI/AdvancedColorPicker";

interface AgendaTodoSidebarProps {
    isOpen: boolean;
    onToggle: () => void;
    activeView: ViewType;
    events: AgendaEvent[];
    todos: PlannerTodo[];
    updateTodo: (id: string, updates: Partial<PlannerTodo>) => void;
}

export default function AgendaTodoSidebar({ isOpen, onToggle, activeView, events, todos, updateTodo }: AgendaTodoSidebarProps) {
    const { t } = useI18n();
    const [colorPickerAnchor, setColorPickerAnchor] = React.useState<{ rect: DOMRect; targetId: string } | null>(null);
    const isDayView = activeView === "日";

    const filteredTodos = todos.filter(todo =>
        events.some(e => e.title === todo.title || e.ext?.todoId === todo.id)
    );

    const toggleTodo = (e: React.MouseEvent, todo: PlannerTodo) => {
        e.stopPropagation();
        updateTodo(todo.id, { completed: !todo.completed });
    };

    const handleColorClick = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        setColorPickerAnchor({
            rect: e.currentTarget.getBoundingClientRect(),
            targetId: id
        });
    };


    const getProcessedContent = (content: string) => {
        const lines = content.split('\n').filter(line => !line.startsWith('# '));

        if (isDayView) {
            return lines.slice(0, 20);
        }

        const h2Lines = lines.filter(line => line.startsWith('## '));
        if (h2Lines.length > 0) {
            return h2Lines;
        }

        return lines.slice(0, 6);
    };

    return (
        <motion.div
            initial={false}
            animate={{
                width: isOpen
                    ? (isDayView ? "calc(100% - 400px)" : 320)
                    : 56,
                backgroundColor: isOpen ? "#fbfbfd" : "#ffffff"
            }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="h-full border-l border-[#d2d2d7] flex flex-col overflow-hidden relative shadow-[-10px_0_30px_rgba(0,0,0,0.02)] shrink-0"
        >
            {/* Header Area */}
            <div
                className={`py-4 px-4 border-b border-[#f2f2f7] bg-white/50 backdrop-blur-sm flex items-center shrink-0 sticky top-0 z-20 cursor-pointer hover:bg-black/[0.02] transition-colors ${isOpen ? 'justify-between' : 'justify-center'}`}
                onClick={onToggle}
            >
                <div className="flex items-center gap-2 overflow-hidden">
                    <ListTodo size={18} className="text-[#0071e3] shrink-0" />
                    {isOpen && (
                        <motion.h3
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            className="text-sm font-semibold text-[#1d1d1f] tracking-tight whitespace-nowrap flex items-baseline gap-2"
                        >
                            <span>{t('sidebar.todo')}</span>
                            {isDayView && <span className="text-[11px] font-normal text-[#86868b] leading-none">Context</span>}
                        </motion.h3>
                    )}
                </div>
                {isOpen && <ChevronRight size={14} className={`text-[#86868b] opacity-40 transition-transform ${isOpen ? 'rotate-180' : ''}`} />}
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar">
                <AnimatePresence mode="popLayout">
                    {isOpen ? (
                        <motion.div
                            key="content-open"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className={`p-4 ${isDayView ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4' : 'space-y-4'}`}
                        >
                            {filteredTodos.map((todo) => (
                                <motion.div
                                    key={todo.id}
                                    whileHover={{ y: -1, scale: 1.005 }}
                                    className={`group relative flex flex-col rounded-2xl border transition-all cursor-pointer overflow-hidden ${isDayView ? 'min-h-[180px]' : 'min-h-[100px] max-h-[400px]'} ${todo.completed
                                        ? "bg-black/[0.02] border-transparent opacity-60"
                                        : "bg-white border-black/5 shadow-sm hover:border-[#0071e3]/20 hover:shadow-lg"
                                        }`}
                                >
                                    <div className={`px-4 py-3 flex items-center gap-4 sticky top-0 z-10 bg-inherit transition-colors ${!todo.completed && 'backdrop-blur-md bg-white/80 border-b border-black/[0.03]'}`}>
                                        <div
                                            className="shrink-0 flex items-center justify-center p-0.5 -m-0.5 rounded-md hover:bg-black/[0.05] transition-colors"
                                            onClick={(e) => toggleTodo(e, todo)}
                                        >
                                            {todo.completed ? (
                                                <CheckSquare size={20} className="text-[#32d74b]" />
                                            ) : (
                                                <Square size={20} className="text-[#d2d2d7] hover:text-[#0071e3] transition-colors" />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0 flex items-center">
                                            <p className={`text-base font-bold leading-tight truncate whitespace-nowrap ${todo.completed ? "line-through text-[#86868b]" : "text-[#1d1d1f]"}`}>
                                                {todo.title}
                                            </p>
                                        </div>

                                        {/* Color Trigger Dot */}
                                        {!todo.completed && (
                                            <div
                                                className="shrink-0 w-3 h-3 rounded-md shadow-sm border border-black/5 hover:scale-125 transition-transform cursor-pointer"
                                                style={{ backgroundColor: todo.ext?.color || '#0071e3' }}
                                                onClick={(e) => handleColorClick(e, todo.id)}
                                            />
                                        )}
                                    </div>

                                    {/* Detailed Content */}
                                    {isOpen && !todo.completed && (
                                        <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-3">
                                            <div className="pl-7 space-y-2">
                                                <MarkdownRenderer
                                                    content={getProcessedContent(todo.content).join('\n')}
                                                    itemClassName="text-[13px] leading-relaxed text-[#424245]"
                                                />
                                                <div className="flex flex-wrap gap-1.5 pt-2">
                                                    {todo.tags?.map((tag: string) => (
                                                        <span key={tag} className="flex items-center gap-1 px-1.5 py-0.5 bg-[#f5f5f7] rounded-md text-[8px] font-black text-[#86868b] uppercase tracking-wider">
                                                            {tag}
                                                        </span>
                                                    ))}
                                                    {todo.pinned && (
                                                        <span className="flex items-center gap-1 px-1.5 py-0.5 bg-[#fff9e6] rounded-md text-[8px] font-black text-[#ff9500] uppercase tracking-wider">
                                                            Pinned
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </motion.div>
                            ))}
                        </motion.div>
                    ) : (
                        <motion.div
                            key="content-closed"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="py-4 flex flex-col items-center gap-4"
                        >
                            {filteredTodos.map((todo) => (
                                <div key={todo.id} className="relative group/mini">
                                    {todo.completed ? (
                                        <CheckSquare size={18} className="text-[#32d74b] opacity-60" />
                                    ) : (
                                        <div
                                            className={`w-3 h-3 rounded-md shadow-sm border border-white transition-colors`}
                                            style={{ backgroundColor: todo.ext?.color || (todo.pinned ? '#ff9500' : '#0071e3') }}
                                        />
                                    )}
                                    {/* Tooltip */}
                                    <div className="absolute left-full ml-3 px-2 py-1 bg-white border border-black/5 shadow-xl text-[#1d1d1f] text-[10px] rounded-lg opacity-0 group-hover/mini:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-all font-medium">
                                        {todo.title}
                                    </div>
                                </div>
                            ))}
                        </motion.div>
                    )}
                </AnimatePresence>

                <AnimatePresence>
                    {colorPickerAnchor && (
                        <AdvancedColorPicker
                            anchorRect={colorPickerAnchor.rect}
                            currentColor={todos.find(t => t.id === colorPickerAnchor.targetId)?.ext?.color}
                            onClose={() => setColorPickerAnchor(null)}
                            onSelect={(color) => {
                                updateTodo(colorPickerAnchor.targetId, {
                                    ext: {
                                        ...(todos.find(t => t.id === colorPickerAnchor.targetId)?.ext || {}),
                                        color
                                    }
                                });
                            }}
                        />
                    )}
                </AnimatePresence>
            </div>

            {
                isOpen && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="p-4 border-t border-[#f2f2f7] bg-white/50 shrink-0"
                    >
                        <div className="flex items-center justify-between text-[10px] text-[#86868b] font-bold uppercase tracking-widest">
                            <span>Synced Tasks</span>
                            <span>{filteredTodos.filter((todo) => !todo.completed).length} items left</span>
                        </div>
                    </motion.div>
                )
            }
        </motion.div >
    );
}
