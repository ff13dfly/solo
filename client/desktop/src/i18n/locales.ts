import { zh } from "./locales/zh";
import { en } from "./locales/en";
import { fr } from "./locales/fr";

export const locales = {
    zh,
    en,
    fr
};

export type LocaleType = keyof typeof locales;
