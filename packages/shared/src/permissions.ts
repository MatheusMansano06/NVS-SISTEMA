/** Permissões atômicas. Formato `recurso:ação`. Novos módulos acrescentam as suas aqui. */
export const PERMISSIONS = ['tenant:read', 'dashboard:read', 'costs:manage', 'listings:manage', 'users:read', 'users:manage'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ['tenant:read', 'dashboard:read', 'costs:manage', 'listings:manage', 'users:read', 'users:manage'],
  admin: ['tenant:read', 'dashboard:read', 'costs:manage', 'listings:manage', 'users:read', 'users:manage'],
  member: ['tenant:read', 'dashboard:read', 'costs:manage', 'listings:manage', 'users:read'],
  viewer: ['tenant:read', 'dashboard:read'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
