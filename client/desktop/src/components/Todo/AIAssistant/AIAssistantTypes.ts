import { PlannerTodo } from "../useTodoSync";

export interface AIModel {
    id: string;
    name: string;
    provider: string;
}

export interface AIAssistantState {
    prompt: string;
    isProcessing: boolean;
    isHidingInput: boolean;
    isLoading: boolean;
    isAutoUpdate: boolean;
    selectedModel: AIModel;
}

export interface AIAssistantActions {
    setPrompt: (prompt: string) => void;
    handleGenerate: () => Promise<void>;
    setIsAutoUpdate: (value: boolean) => void;
    setSelectedModel: (model: AIModel) => void;
    setIsModelOpen: (open: boolean) => void;
}

export interface AIAssistantProps {
    onAddTodos: (todos: { title: string; content: string }[]) => void;
    onManualAdd: () => void;
    onUploadFile: (file: File) => void;
    selectedTodo?: PlannerTodo;
    onDeselectTodo: () => void;
    onUpdateTodo: (id: string, updates: Partial<PlannerTodo>) => void;
}
