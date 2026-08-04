import { ForbiddenException } from '@nestjs/common';
import { AdminAccess, AppUser } from './domain';

export function normalizeOrgPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

export function orgPathIncludes(scope: string, target: string): boolean {
  if (!scope?.trim() || !target?.trim()) return false;
  const normalizedScope = normalizeOrgPath(scope);
  const normalizedTarget = normalizeOrgPath(target);
  return normalizedScope === '/' || normalizedTarget === normalizedScope || normalizedTarget.startsWith(normalizedScope);
}

export function resolveAdminAccess(user: AppUser): AdminAccess {
  if (user.status !== 'ACTIVE') throw new ForbiddenException('administrator role is required');
  const bindings = user.roleBindings ?? [];
  const globalBinding = bindings.some((binding) => ['global_admin', 'admin'].includes(binding.role) && normalizeOrgPath(binding.scopeOrgPath) === '/');
  const scopedLegacyBindings = bindings.filter((binding) => binding.role === 'admin' && normalizeOrgPath(binding.scopeOrgPath) !== '/');
  if (user.roles.includes('global_admin') || globalBinding || (user.roles.includes('admin') && scopedLegacyBindings.length === 0)) {
    return { level: 'GLOBAL', scopeOrgPaths: ['/'] };
  }
  const scopeOrgPaths = [
    ...bindings.filter((binding) => ['department_admin', 'admin'].includes(binding.role)).map((binding) => normalizeOrgPath(binding.scopeOrgPath)),
    ...(user.roles.includes('department_admin') && user.orgPath ? [normalizeOrgPath(user.orgPath)] : []),
  ].filter((path, index, all) => all.indexOf(path) === index);
  if (scopeOrgPaths.includes('/')) return { level: 'GLOBAL', scopeOrgPaths: ['/'] };
  if (scopeOrgPaths.length) return { level: 'DEPARTMENT', scopeOrgPaths };
  throw new ForbiddenException('administrator role is required');
}

/** Return whether a user retains effective global administration access. */
export function hasGlobalAdminAccess(user: AppUser): boolean {
  try {
    return resolveAdminAccess(user).level === 'GLOBAL';
  } catch {
    return false;
  }
}

export function assertAdminOrgScope(access: AdminAccess, targetOrgPath: string): void {
  if (access.level === 'GLOBAL' || access.scopeOrgPaths.some((scope) => orgPathIncludes(scope, targetOrgPath))) return;
  throw new ForbiddenException('organization scope does not allow this operation');
}
