import { describe, expect, it } from 'vitest';
import { hasPermission } from './permissions.js';

describe('hasPermission', () => {
  it('permite admin gerenciar usuários', () => {
    expect(hasPermission('admin', 'users:manage')).toBe(true);
  });
  it('nega viewer ler usuários', () => {
    expect(hasPermission('viewer', 'users:read')).toBe(false);
  });
});
