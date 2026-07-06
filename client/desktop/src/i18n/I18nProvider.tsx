import React, { createContext, useContext, useState, useEffect } from 'react';
import { locales, LocaleType } from './locales';

interface I18nContextType {
    locale: LocaleType;
    setLocale: (locale: LocaleType) => void;
    t: (path: string) => any;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // Try to load from localStorage or default to zh
    const [locale, setLocaleState] = useState<LocaleType>(() => {
        const saved = localStorage.getItem('solo-locale');
        return (saved as LocaleType) || 'zh';
    });

    const setLocale = (newLocale: LocaleType) => {
        setLocaleState(newLocale);
        localStorage.setItem('solo-locale', newLocale);
    };

    const t = (path: string) => {
        const keys = path.split('.');
        let result: any = locales[locale];
        for (const key of keys) {
            if (result && result[key] !== undefined) {
                result = result[key];
            } else {
                return path; // Fallback to key
            }
        }
        return result;
    };

    return (
        <I18nContext.Provider value={{ locale, setLocale, t }}>
            {children}
        </I18nContext.Provider>
    );
};

export const useI18n = () => {
    const context = useContext(I18nContext);
    if (!context) {
        throw new Error('useI18n must be used within an I18nProvider');
    }
    return context;
};
