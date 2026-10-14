import { describe, expect, it } from 'vitest';
import { patient } from './returns-sync.js';

describe('chamadas ao ML com limite de requisições', () => {
  it('espera e repete quando o ML responde 429, sem pular', async () => {
    let n = 0;
    const waits: number[] = [];
    const r = await patient(async () => {
      if (++n < 3) throw Object.assign(new Error('Too Many Requests'), { status: 429 });
      return 'ok';
    }, async (ms) => void waits.push(ms));
    expect(r).toBe('ok');
    expect(waits).toEqual([2_000, 4_000]);
  });

  it('outros erros sobem na hora; 429 sem fim desiste depois das esperas', async () => {
    await expect(patient(async () => { throw Object.assign(new Error('x'), { status: 500 }); }, async () => undefined)).rejects.toThrow('x');
    let n = 0;
    await expect(patient(async () => { n++; throw Object.assign(new Error('429'), { status: 429 }); }, async () => undefined)).rejects.toThrow('429');
    expect(n).toBe(6);
  });
});
