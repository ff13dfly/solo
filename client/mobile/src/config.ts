// Application Configuration
// All configuration settings for the mobile client should be defined here

export const API_CONFIG = {
  // Router URL - change this for production deployment
  ROUTER_URL: 'http://localhost:8600/api/rpc',
  
  // Timeout settings
  REQUEST_TIMEOUT: 30000, // 30 seconds
  
  // Retry settings
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000, // 1 second
};

export const UI_CONFIG = {
  // Modal settings
  FORM_MODAL_HEIGHT_PERCENTAGE: 50, // 30% of screen height
};

// Environment-specific overrides
const ENV = import.meta.env.MODE || 'development';

if (ENV === 'production') {
  // Override with production URL
  // API_CONFIG.ROUTER_URL = 'https://api.yourdomain.com/jsonrpc';
}

export default API_CONFIG;
