/**
 * Branding Utility
 * Reads the deploy-time system display name injected via config.js.
 */

// Seed from config.js injection if present, otherwise fall back to the pre-existing brand word.
export const SYSTEM_NAME: string =
  (typeof window !== 'undefined' && (window as any).__SOLO_SYSTEM_NAME__)
    ? String((window as any).__SOLO_SYSTEM_NAME__)
    : 'SOLO';
