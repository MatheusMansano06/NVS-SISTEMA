import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenCipher } from './token-cipher.js';

const key = randomBytes(32).toString('hex');

describe('TokenCipher', () => {
  it('criptografa e recupera o valor; o texto cifrado não revela o original', () => {
    const c = new TokenCipher(key);
    const enc = c.encrypt('APP_USR-123-segredo');
    expect(enc).not.toContain('segredo');
    expect(c.decrypt(enc)).toBe('APP_USR-123-segredo');
    expect(c.encrypt('x')).not.toBe(c.encrypt('x')); // IV aleatório
  });
  it('detecta adulteração', () => {
    const c = new TokenCipher(key);
    const [v, iv, tag, data] = c.encrypt('valor').split('.');
    const tampered = [v, iv, tag, Buffer.from('outro').toString('base64url')].join('.');
    expect(() => c.decrypt(tampered)).toThrow();
    expect(data).toBeTruthy();
  });
  it('rejeita chave de tamanho errado', () => {
    expect(() => new TokenCipher('abcd')).toThrow();
  });
});
