import type { Role } from '@nvs/shared';

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: Date;
}

export interface UserWithSecret extends User {
  passwordHash: string;
}
