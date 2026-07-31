/**
 * Branding Utility
 * Reads the deploy-time system display name injected via config.js.
 */

// Seed from config.js injection if present, otherwise fall back to the generic default.
export const SYSTEM_NAME: string =
  (typeof window !== 'undefined' && (window as any).__SOLO_SYSTEM_NAME__)
    ? String((window as any).__SOLO_SYSTEM_NAME__)
    : 'SYSTEM';

// Optional deploy-time description of what this instance is for. Empty when unset —
// callers fall back to a generic i18n string rather than baking a default in here.
export const SYSTEM_DESCRIPTION: string =
  (typeof window !== 'undefined' && (window as any).__SOLO_SYSTEM_DESCRIPTION__)
    ? String((window as any).__SOLO_SYSTEM_DESCRIPTION__)
    : '';
