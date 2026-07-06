import React from "react";
import { motion } from "framer-motion";
import { Loader2, Sparkles } from "lucide-react";
import { StatusCycle } from "./StatusCycle";

export function ProcessingPanel() {
    return (
        <motion.div
            key="processing"
            initial={{ x: -20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -20, opacity: 0 }}
            className="flex-1 flex flex-col justify-center gap-1.5 px-2"
        >
            <div className="flex items-center gap-3">
                <div className="relative flex items-center justify-center">
                    <Loader2 size={24} className="animate-spin text-[#0071e3]" />
                    <Sparkles size={10} className="absolute text-[#0071e3] animate-pulse" />
                </div>
                <div className="flex flex-col">
                    <span className="text-[13px] font-bold text-[#1d1d1f]">
                        <StatusCycle />
                    </span>
                    <span className="text-[10px] font-bold text-[#86868b] uppercase tracking-widest opacity-60">Thinking...</span>
                </div>
            </div>
        </motion.div>
    );
}
