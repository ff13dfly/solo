import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useI18n } from "../../../i18n/I18nProvider";

export function StatusCycle() {
    const { locale } = useI18n();
    const steps = locale === 'zh'
        ? ["正在解析您的指令...", "正在检索相关上下文...", "正在构思任务结构...", "正在为您生成建议..."]
        : ["Analyzing instructions...", "Retrieving context...", "Structuring tasks...", "Generating suggestions..."];

    const [index, setIndex] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setIndex((prev) => (prev + 1) % steps.length);
        }, 1200);
        return () => clearInterval(interval);
    }, [steps.length]);

    return (
        <AnimatePresence mode="wait">
            <motion.span
                key={index}
                initial={{ opacity: 0, filter: 'blur(4px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(4px)' }}
                transition={{ duration: 0.3 }}
            >
                {steps[index]}
            </motion.span>
        </AnimatePresence>
    );
}
