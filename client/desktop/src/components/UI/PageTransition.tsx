import React from 'react';
import { motion } from 'framer-motion';

interface PageTransitionProps {
    children: React.ReactNode;
    id: string;
}

export const PageTransition: React.FC<PageTransitionProps> = ({ children, id }) => {
    return (
        <motion.div
            key={id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="h-full w-full"
        >
            {children}
        </motion.div>
    );
};
