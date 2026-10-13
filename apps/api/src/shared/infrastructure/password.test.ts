import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password', () => {
  it('valida senha correta e rejeita incorreta', async () => {
    const hash = await hashPassword('senha-super-segura');
    expect(hash).not.toContain('senha-super-segura');
    expect(await verifyPassword('senha-super-segura', hash)).toBe(true);
    expect(await verifyPassword('outra-senha', hash)).toBe(false);
  });
  it('rejeita hash malformado', async () => {
    expect(await verifyPassword('x', 'lixo')).toBe(false);
  });
});
