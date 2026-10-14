import { describe, expect, it } from 'vitest';
import { KeyedMutex } from './keyed-mutex.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('serializa a mesma chave e libera chaves diferentes em paralelo', async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const job = (key: string, name: string, ms: number) =>
      m.run(key, async () => {
        log.push(`${name}+`);
        await sleep(ms);
        log.push(`${name}-`);
      });
    await Promise.all([job('a', 'a1', 20), job('a', 'a2', 1), job('b', 'b1', 1)]);
    expect(log.indexOf('a1-')).toBeLessThan(log.indexOf('a2+'));
    expect(log.indexOf('b1+')).toBeLessThan(log.indexOf('a1-'));
  });

  it('segue a fila mesmo quando uma tarefa falha', async () => {
    const m = new KeyedMutex();
    await expect(m.run('k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(m.run('k', async () => 1)).resolves.toBe(1);
  });
});
