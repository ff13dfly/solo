import React, { useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { CheckSquare, Plus } from "lucide-react";
import { AgendaEvent, PRESET_COLORS, formatTime } from "./AgendaTypes";
import { PlannerTodo } from "../Todo/useTodoSync";
import { DragMode } from "./useAgendaDrag";

interface AgendaEventCardProps {
    event: Partial<AgendaEvent> & { id: string };
    isEditing: boolean;
    isSelected?: boolean;
    isDraft?: boolean;
    isDragging?: boolean;
    startTime?: number;
    endTime?: number;
    top: number;
    height: number;
    todos: PlannerTodo[];
    onTitleChange: (id: string, title: string, e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onUpdateEvent: (event: AgendaEvent) => void;
    onColorClick: (rect: DOMRect, id: string) => void;
    onTodoClick: (rect: DOMRect, id: string) => void;
    onKeyDown: (e: React.KeyboardEvent, id: string) => void;
    onBlur: (id: string) => void;
    onEdit: (id: string) => void;
    onPointerDown: (id: string, e: React.PointerEvent, mode?: DragMode) => void;
}

export const AgendaEventCard: React.FC<AgendaEventCardProps> = ({
    event,
    isEditing,
    isSelected = false,
    isDraft = false,
    isDragging = false,
    top,
    height,
    todos,
    onTitleChange,
    onUpdateEvent,
    onColorClick,
    onTodoClick,
    onKeyDown,
    onBlur,
    onEdit,
    onPointerDown
}) => {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isEditing && inputRef.current) {
            const timer = setTimeout(() => {
                const el = inputRef.current!;
                el.focus();
                // Move cursor to end
                const len = el.value.length;
                el.setSelectionRange(len, len);
            }, 10);
            return () => clearTimeout(timer);
        }
    }, [isEditing]);

    const todoId = event.ext?.todoId;
    const linkedTodo = todos.find(t => t.id === todoId);

    // Color Priority: User Override (event.ext?.color) > Linked Todo Color > Default
    const defaultColor = PRESET_COLORS[0];
    const todoColor = linkedTodo?.ext?.color;
    const displayColor = event.ext?.color || todoColor || defaultColor;

    const isInverted = isSelected && !isEditing;
    const backgroundColor = isEditing
        ? '#ffffff'
        : isSelected
            ? displayColor
            : `${displayColor}15`;

    const contentColor = isInverted ? '#ffffff' : displayColor;
    const subColor = isInverted ? 'rgba(255,255,255,0.8)' : displayColor;

    const stateClasses = isEditing
        ? 'z-30 bg-white shadow-xl border-y-transparent border-r-transparent'
        : isSelected
            ? 'z-20 shadow-lg select-none border-y-transparent border-r-transparent'
            : 'z-10 hover:shadow-md border border-black/[0.03]';

    return (
        <motion.div
            className={`absolute left-[2px] right-[2px] rounded-lg shadow-sm overflow-hidden group transition-all duration-150 flex flex-col border-l-[4px] ${stateClasses}`}
            style={{
                top: top + 1,
                height: height - 2,
                backgroundColor,
                borderLeftColor: displayColor,
                pointerEvents: isDragging ? 'none' : 'auto',
                opacity: isDragging ? 0 : 1,
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => {
                if (isEditing) return;
                e.stopPropagation();
                onPointerDown(event.id, e, 'move');
            }}
        >
            {/* Resize Handles */}
            {!isEditing && (
                <>
                    <div
                        className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize z-50 hover:bg-black/5 transition-colors"
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            onPointerDown(event.id, e, 'resize-top');
                        }}
                    />
                    <div
                        className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize z-50 hover:bg-black/5 transition-colors"
                        onPointerDown={(e) => {
                            e.stopPropagation();
                            onPointerDown(event.id, e, 'resize-bottom');
                        }}
                    />
                </>
            )}

            <div className="p-3 flex-1 flex flex-col min-h-0">
                {isEditing ? (
                    <div className="flex-1 flex flex-col min-h-0" onPointerDown={(e) => e.stopPropagation()}>
                        <textarea
                            ref={inputRef as any}
                            className="w-full flex-1 bg-transparent border-none outline-none font-bold text-sm resize-none no-scrollbar leading-tight py-0"
                            style={{ color: '#1d1d1f' }}
                            value={event.title || ""}
                            placeholder={isDraft ? "New Event" : ""}
                            onChange={(e) => onTitleChange(event.id, e.target.value, e)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    onKeyDown(e, event.id);
                                } else {
                                    onKeyDown(e, event.id);
                                }
                            }}
                            onBlur={() => onBlur(event.id)}
                        />
                    </div>
                ) : (
                    <div
                        className="flex-1 font-bold text-sm tracking-tight cursor-text overflow-hidden break-words leading-tight"
                        style={{ color: contentColor }}
                        data-agenda-title="true"
                    >
                        {event.title || (isDraft ? "New Event" : "No Title")}
                    </div>
                )}

                <div className="mt-auto flex justify-between items-end gap-2">
                    <div className="flex items-center gap-2">
                        <div
                            className={`w-2.5 h-2.5 rounded-[2px] cursor-pointer hover:scale-110 transition-transform shadow-sm ${isInverted ? 'border border-white/20' : ''}`}
                            style={{ backgroundColor: isInverted ? '#ffffff' : displayColor }}
                            onPointerDown={(e) => {
                                e.stopPropagation();
                                onPointerDown(event.id, e, 'move'); // Trigger selection
                            }}
                            onClick={(e) => {
                                e.stopPropagation();
                                onColorClick(e.currentTarget.getBoundingClientRect(), event.id);
                            }}
                        />
                        <div className="text-[10px] font-bold whitespace-nowrap tracking-tight" style={{ color: subColor }}>
                            {isDraft ? formatTime(event.startTime!) : `${formatTime(event.startTime!)} - ${formatTime(event.endTime!)}`}
                        </div>
                    </div>

                    <div className="flex items-center gap-2 overflow-hidden">
                        {todoId ? (
                            <div
                                className="px-2 py-0.5 rounded-md flex items-center gap-1 max-w-[100%] overflow-hidden cursor-pointer transition-colors"
                                style={{ backgroundColor: isInverted ? 'rgba(255,255,255,0.2)' : '#f2f2f7' }}
                                onPointerDown={(e) => {
                                    e.stopPropagation();
                                    onPointerDown(event.id, e, 'move'); // Trigger selection
                                }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onTodoClick(e.currentTarget.getBoundingClientRect(), event.id);
                                }}
                            >
                                <CheckSquare size={10} className="shrink-0" style={{ color: subColor }} />
                                <span className="text-[9px] font-bold truncate uppercase tracking-tight" style={{ color: subColor }}>
                                    {linkedTodo?.title || "Todo"}
                                </span>
                            </div>
                        ) : (
                            <div
                                className={`w-5 h-5 rounded-md flex items-center justify-center cursor-pointer transition-all ${isInverted ? 'bg-white/20' : 'bg-[#f2f2f7]'} ${isDraft ? '' : 'opacity-40 hover:opacity-100 hover:scale-110'}`}
                                onPointerDown={(e) => {
                                    e.stopPropagation();
                                    onPointerDown(event.id, e, 'move'); // Trigger selection
                                }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onTodoClick(e.currentTarget.getBoundingClientRect(), event.id);
                                }}
                            >
                                <Plus size={12} strokeWidth={3} className={isInverted ? 'text-white' : (isDraft ? 'text-[#0071e3]' : `text-[${subColor}]`)} style={{ color: isInverted ? '#ffffff' : (isDraft ? '#0071e3' : subColor) }} />
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </motion.div>
    );
};
