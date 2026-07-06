/**
 * Permission Configuration
 * Defines restricted services and other settings for the Permit Modal
 */

export const PERMIT_CONFIG = {
    /**
     * Services that are restricted from fine-grained permission configuration.
     * These services will not appear in the service selection dropdown or
     * the detailed methods configuration list.
     */
    restrictedServices: ['administrator', 'user'],
};
