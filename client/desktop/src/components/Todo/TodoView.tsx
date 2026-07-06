import React, { useState } from "react";
import { Plus } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useI18n } from "../../i18n/I18nProvider";
import { useTodoSync, PlannerTodo } from "./useTodoSync";
import TodoDocumentCard from "./TodoDocumentCard";
import TodoEditor from "./TodoEditor";
import TodoAIAssistant from "./TodoAIAssistant";

export default function TodoView() {
    const { t } = useI18n();
    const { todos, addTodo, updateTodo, deleteTodo } = useTodoSync();
    const [editingTodo, setEditingTodo] = useState<PlannerTodo | null>(null);
    const [inlineEditingId, setInlineEditingId] = useState<string | null>(null);
    const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);

    const selectedTodo = todos.find(t => t.id === selectedTodoId);

    const handleCreate = () => {
        const newTitle = t('todo.new_document') || "New Todo";
        const newTodo = addTodo(newTitle, `# ${newTitle}`);
        setInlineEditingId(newTodo.id);
    };

    const handleAITodos = (newTasks: { title: string; content: string }[]) => {
        newTasks.forEach(task => {
            addTodo(task.title, task.content);
        });
    };

    const handleInlineTitleUpdate = (id: string, newTitle: string, content: string) => {
        const lines = content.split('\n');
        let newContent = content;
        if (lines.length > 0 && lines[0].startsWith('#')) {
            lines[0] = `# ${newTitle}`;
            newContent = lines.join('\n');
        } else {
            newContent = `# ${newTitle}\n${content}`;
        }
        updateTodo(id, { title: newTitle, content: newContent });
    };

    const handleFileUpload = async (file: File) => {
        try {
            const content = await file.text();
            const title = file.name.replace(/\.[^/.]+$/, "");
            addTodo(title, content);
        } catch (err) {
            console.error("Failed to upload file:", err);
        }
    };

    return (
        <div className="flex-1 h-full bg-[#f5f5f7] overflow-hidden relative flex flex-col">
            <header className="flex-shrink-0 bg-white/80 backdrop-blur-md border-b border-[#d2d2d7] sticky top-0 z-20 flex items-center px-6 py-3">
                <div className="flex-1">
                    <h2 className="text-xl font-bold tracking-tight text-[#1d1d1f]">
                        {t('sidebar.todo')}
                    </h2>
                    <p className="text-[10px] text-[#86868b] mt-0.5 flex items-center gap-1 font-medium">
                        {t('todo.subtitle')}
                    </p>
                </div>
            </header>

            <div className="flex-1 relative flex flex-col min-h-0">
                <div
                    className="flex-1 min-h-0 pt-6 px-6 pb-48 overflow-x-auto no-scrollbar snap-x snap-mandatory select-none"
                    onClick={() => setSelectedTodoId(null)}
                >
                    <div className={`flex gap-4 h-full items-stretch ${todos.length > 3 ? 'min-w-max' : 'w-full'}`}>
                        <AnimatePresence>
                            {todos.map((todo) => (
                                <div
                                    key={todo.id}
                                    className="flex-shrink-0 snap-start h-full"
                                    style={{
                                        width: todos.length === 1 ? '50%' :
                                            todos.length === 2 ? '40%' :
                                                '25%',
                                        minWidth: todos.length >= 3 ? '310px' : '310px' // Keep a reasonable minimum for all
                                    }}
                                >
                                    <TodoDocumentCard
                                        todo={todo}
                                        isInlineEditing={inlineEditingId === todo.id}
                                        isSelected={selectedTodoId === todo.id}
                                        onSelect={() => setSelectedTodoId(selectedTodoId === todo.id ? null : todo.id)}
                                        onEdit={() => setEditingTodo(todo)}
                                        onDelete={() => deleteTodo(todo.id)}
                                        onUpdate={(updates) => updateTodo(todo.id, updates)}
                                        onStartInlineEdit={() => setInlineEditingId(todo.id)}
                                        onFinishInlineEdit={(newTitle) => {
                                            handleInlineTitleUpdate(todo.id, newTitle, todo.content);
                                            setInlineEditingId(null);
                                        }}
                                    />
                                </div>
                            ))}
                        </AnimatePresence>
                    </div>
                </div>

                <TodoAIAssistant
                    onAddTodos={handleAITodos}
                    onManualAdd={handleCreate}
                    onUploadFile={handleFileUpload}
                    selectedTodo={selectedTodo}
                    onDeselectTodo={() => setSelectedTodoId(null)}
                    onUpdateTodo={updateTodo}
                />

                {/* Simple Markdown Editor Overlay */}
                <AnimatePresence>
                    {editingTodo && (
                        <TodoEditor
                            todo={editingTodo}
                            onClose={() => setEditingTodo(null)}
                            onUpdate={(updates) => updateTodo(editingTodo.id, updates)}
                            titleRef={null}
                        />
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}
