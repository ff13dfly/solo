import { useState, useRef } from "react";
import { AIModel, AIAssistantState } from "./AIAssistantTypes";

export const MODELS: AIModel[] = [
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "google" },
    { id: "qwen-turbo", name: "Qwen Turbo", provider: "alibaba" },
    { id: "gpt-4", name: "GPT-4", provider: "openai" },
];

export function useAIAssistant() {
    const [prompt, setPrompt] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [selectedModel, setSelectedModel] = useState(MODELS[0]);
    const [isModelOpen, setIsModelOpen] = useState(false);
    const [isAutoUpdate, setIsAutoUpdate] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isHidingInput, setIsHidingInput] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleGenerate = async () => {
        if (!prompt.trim() || isLoading || isProcessing || isHidingInput) return;
        setIsHidingInput(true);
    };

    const startProcessing = () => {
        if (isHidingInput && !isProcessing) {
            setIsProcessing(true);
            // Mock processing delay for UI demonstration
            setTimeout(() => {
                setIsProcessing(false);
                setIsHidingInput(false);
                setPrompt("");
            }, 4000);
        }
    };

    return {
        state: {
            prompt,
            isLoading,
            selectedModel,
            isModelOpen,
            isAutoUpdate,
            isProcessing,
            isHidingInput,
        } as AIAssistantState & { isModelOpen: boolean },
        actions: {
            setPrompt,
            setSelectedModel,
            setIsModelOpen,
            setIsAutoUpdate,
            handleGenerate,
            startProcessing,
        },
        fileInputRef,
    };
}
