import type { Permit } from '../../types';

/**
 * Shared permit primitives — ONE copy for every permit surface (editor, read-only
 * view, sentinel needs-vs-grants), so the verdict shown anywhere in the portal
 * always matches what the Router will decide.
 */

// Exact mirror of router/handlers/auth.js checkPermission (= nexus identity.js
// permitAllows): a method is allowed iff the permit is allow_all, or enumerates
// the method's FULL name (or '*') under the method's service segment.
export function permitAllows(permit: Permit | null | undefined, method: string): boolean {
  if (!permit) return false;
  if (permit.allow_all) return true;
  if (!permit.services) return false;
  const service = String(method).split('.')[0];
  const allowed = permit.services[service];
  if (!allowed) return false;
  return allowed.includes('*') || allowed.includes(method);
}

// Group a service's methods by their entity segment ({service}.{entity}.{action})
// — the structure both the editor's checkbox groups and the read-only view share.
export function groupMethodsByPrefix<T extends { name: string }>(
  methods: T[],
  serviceId: string
): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  methods.forEach(m => {
    const relativeName = m.name.startsWith(`${serviceId}.`)
      ? m.name.substring(serviceId.length + 1)
      : m.name;
    const parts = relativeName.split('.');
    if (parts.length > 1) {
      const groupName = parts[0];
      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(m);
    }
  });
  return groups;
}
