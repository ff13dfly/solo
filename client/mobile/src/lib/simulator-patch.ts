/**
 * Simulator Patch for Solo·AI Mobile Client
 * 
 * This script provides a sandbox environment when the app is nested within an iframe.
 * It replaces localStorage with an in-memory object and listens for commands from the parent window.
 */

export function isSimulator() {
  if (typeof window === 'undefined') return false;
  return window.self !== window.top;
}

export function initSimulatorPatch() {
  if (typeof window === 'undefined') return;

  const isNested = isSimulator();

  if (isNested) {
    console.log('📱 [Simulator] Sandbox mode active. Interop enabled.');

    // 2. Monkey-patch localStorage with a sessionStorage-backed stub
    const STORAGE_PREFIX = 'solo_sim_sandbox_';
    
    const storageManager = (() => {
      const notifyParent = () => {
        const store: Record<string, string> = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key?.startsWith(STORAGE_PREFIX)) {
            store[key.replace(STORAGE_PREFIX, '')] = sessionStorage.getItem(key) || '';
          }
        }
        window.parent.postMessage({
          type: 'STORAGE_UPDATE',
          payload: { store }
        }, '*');
      };

      return {
        getItem: (key: string) => sessionStorage.getItem(STORAGE_PREFIX + key),
        setItem: (key: string, value: string) => { 
          sessionStorage.setItem(STORAGE_PREFIX + key, value.toString()); 
          notifyParent();
        },
        removeItem: (key: string) => { 
          sessionStorage.removeItem(STORAGE_PREFIX + key); 
          notifyParent();
        },
        clear: () => { 
          const keys = [];
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
          }
          keys.forEach(k => sessionStorage.removeItem(k));
          notifyParent();
        },
        get length() { 
          let count = 0;
          for (let i = 0; i < sessionStorage.length; i++) {
            if (sessionStorage.key(i)?.startsWith(STORAGE_PREFIX)) count++;
          }
          return count;
        },
        key: (index: number) => {
          let count = 0;
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key?.startsWith(STORAGE_PREFIX)) {
              if (count === index) return key.replace(STORAGE_PREFIX, '');
              count++;
            }
          }
          return null;
        },
        _batchUpdate: (newStore: Record<string, string>) => {
          Object.entries(newStore).forEach(([key, value]) => {
            sessionStorage.setItem(STORAGE_PREFIX + key, value);
          });
        }
      };
    })();

    // Replace the global localStorage
    Object.defineProperty(window, 'localStorage', {
      value: storageManager,
      writable: true,
      configurable: true
    });

    // 3. Command Listener (postMessage)
    window.addEventListener('message', (event) => {
      const { type, payload } = event.data;

      if (type === 'SYNC_STORAGE') {
        const newStore = payload.store || {};
        
        // Deep compare to verify if reload is actually needed
        let hasChanged = false;
        
        // 1. Check Key Count
        const currentKeys = [];
        for(let i=0; i<localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k) currentKeys.push(k);
        }

        const newKeys = Object.keys(newStore);
        if (currentKeys.length !== newKeys.length) {
            hasChanged = true;
        } else {
            // 2. Check Values
            for (const key of newKeys) {
                if (localStorage.getItem(key) !== newStore[key]) {
                    hasChanged = true;
                    break;
                }
            }
        }

        if (hasChanged) {
            console.log('🔄 [Simulator] Syncing storage (Data changed, reloading)');
            (localStorage as any)._batchUpdate(newStore);
            // Short delay to ensure storage is committed
            setTimeout(() => window.location.reload(), 100);
        } else {
            console.log('✨ [Simulator] Syncing storage (Data identical, skip reload)');
            // CRITICAL: Tell parent we are done, even if we didn't reload
            window.parent.postMessage({ type: 'SYNC_COMPLETE' }, '*');
        }

      } else if (type === 'SIMULATE_INPUT') {
        // Find the chat input and simulate typing
        const input = document.querySelector('input[type="text"]') as HTMLInputElement;
        if (input) {
          // React-friendly way to trigger input change
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          nativeInputValueSetter?.call(input, payload.text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else if (type === 'SIMULATE_CLICK') {
          const button = document.querySelector(payload.selector) as HTMLElement;
          if (button) {
            button.click();
          }
      } else if (type === 'SET_TOKEN') {
          // Inject token into our sandboxed storage
          localStorage.setItem('auth_token', payload.token);
          window.location.reload();
      } else if (type === 'RESET_SANDBOX') {
          console.log('🧹 [Simulator] Resetting sandbox storage and reloading');
          localStorage.clear(); 
          window.location.reload();
      }
    });

    // Signal to parent that we are ready
    window.parent.postMessage({ type: 'SIMULATOR_READY' }, '*');
  }
}
