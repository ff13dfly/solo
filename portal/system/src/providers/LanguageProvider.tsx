import React, { createContext, useContext, useState } from 'react';
import en from '../locales/en';
import zh from '../locales/zh';

// Type definition for the dictionary structure (using 'en' as reference)
type Dictionary = typeof en;
type Language = 'en' | 'zh';

const dictionaries: Record<Language, Dictionary> = { en, zh };

interface LanguageContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (path: string, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    return (localStorage.getItem('app_lang') as Language) || 'en';
  });

  const setLang = (newLang: Language) => {
    setLangState(newLang);
    localStorage.setItem('app_lang', newLang);
  };

  // Helper function to access nested keys like 'nav.dashboard'
  const t = (path: string, params?: Record<string, string | number>): string => {
    const keys = path.split('.');
    let current: any = dictionaries[lang];
    
    for (const key of keys) {
      if (current[key] === undefined) {
        console.warn(`Translation missing for key: ${path}`);
        return path;
      }
      current = current[key];
    }
    
    let result = current as string;
    if (params) {
        Object.entries(params).forEach(([key, value]) => {
            result = result.replace(new RegExp(`{${key}}`, 'g'), String(value));
        });
    }
    return result;
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLang() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLang must be used within a LanguageProvider');
  }
  return context;
}
