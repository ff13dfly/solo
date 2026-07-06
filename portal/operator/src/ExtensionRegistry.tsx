import React from 'react';

/**
 * NON_DISCOVERABLE_SERVICES defines the blacklist of core infrastructure services
 * that should NOT be exposed in the operator portal for direct data management.
 * These are system-level services (from api/core/) that either:
 * - Have specialized management interfaces elsewhere
 * - Are internal infrastructure components not meant for direct manipulation
 * 
 * All other services (especially those in api/apps/) will be automatically discovered
 * and rendered with the Model-Driven UI.
 */
export const NON_DISCOVERABLE_SERVICES = [
  'router',        // Gateway service, no data management needed
  'agent',         // AI service, not for direct data manipulation
  'orchestrator',  // Workflow engine, managed through workflows
  'user',          // User service, has specialized management UI
  'administrator', // System admin service, has specialized UI
  // 'gateway' removed — now manages SMTP accounts, email templates, and SMS templates
  'nexus',         // Core data hub
  'notification',  // Notification service
];

import FulfillmentPage from './pages/fulfillment';
import StoragePage from './pages/storage';

const AssetPage = () => React.createElement(StoragePage, { serviceId: 'asset' });

/**
 * ExtensionRegistry maps microservice IDs to their specialized management components.
 * If a service is NOT in this registry, it will use GenericEntityPage.
 */
export const ExtensionRegistry: Record<string, React.ComponentType<any>> = {
  'fulfillment': FulfillmentPage,
  'storage': StoragePage,
  'asset': AssetPage,
};

export const getComponentForService = (serviceId: string, fallback: React.ComponentType<any>) => {
  return ExtensionRegistry[serviceId] || fallback;
};
