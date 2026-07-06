import { getCurrentRouterUrl } from './routerManager';

/**
 * resolveAssetUrl
 * @why The storage service now returns absolute object-store (OSS/CDN) URLs from
 *      resolve()/list()/multi(). This passes those through unchanged. A bare
 *      relative value (legacy) is resolved against the current router origin.
 *      No hard-coded storage port anymore.
 */
export function resolveAssetUrl(url: string | undefined): string {
    if (!url) return '';

    // Already an absolute URL (the new normal) — use as-is.
    if (/^https?:\/\//.test(url)) return url;

    // Legacy/relative fallback: resolve against the current router origin.
    const routerUrl = getCurrentRouterUrl().replace(/\/$/, '');
    return `${routerUrl}/${url.replace(/^\//, '')}`;
}
