/**
 * Router Management Utility
 * Manages multiple router addresses in localStorage
 */

const STORAGE_KEY = 'solomind:router_addresses';
const CURRENT_INDEX_KEY = 'solomind:current_router_index';

// Seed from config.js injection if present, otherwise fall back to SSL proxy default.
const _seed: string = (typeof window !== 'undefined' && (window as any).__SOLO_ROUTER__)
  ? String((window as any).__SOLO_ROUTER__).replace(/\/?$/, '/')
  : 'https://localhost:8800/';
const DEFAULT_ROUTERS = [_seed];

export interface RouterInfo {
  url: string;
  name: string;
}

export function getRouterAddresses(): RouterInfo[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      console.error('[RouterManager] Failed to parse router addresses', e);
    }
  }
  return DEFAULT_ROUTERS.map(url => ({ url, name: 'Default Router' }));
}

export function saveRouterAddresses(addresses: RouterInfo[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(addresses));
}

export function getCurrentRouterIndex(): number {
  const index = localStorage.getItem(CURRENT_INDEX_KEY);
  return index ? parseInt(index, 10) : 0;
}

export function setCurrentRouterIndex(index: number) {
  localStorage.setItem(CURRENT_INDEX_KEY, index.toString());
}

export function getCurrentRouterUrl(): string {
  const addresses = getRouterAddresses();
  const index = getCurrentRouterIndex();
  return addresses[index]?.url || DEFAULT_ROUTERS[0];
}

export function addRouter(name: string, url: string) {
  const addresses = getRouterAddresses();
  addresses.push({ name, url });
  saveRouterAddresses(addresses);
}

export function removeRouter(index: number) {
  const addresses = getRouterAddresses();
  if (addresses.length <= 1) return; // Keep at least one
  
  const currentIndex = getCurrentRouterIndex();
  addresses.splice(index, 1);
  saveRouterAddresses(addresses);
  
  if (currentIndex === index) {
    setCurrentRouterIndex(0);
  } else if (currentIndex > index) {
    setCurrentRouterIndex(currentIndex - 1);
  }
}
