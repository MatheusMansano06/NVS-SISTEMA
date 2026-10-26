import { describe, expect, it } from 'vitest';
import { classifyAbc } from './abc-curve.js';

const classes = (values: number[]) => {
  const m = classifyAbc(values.map((v, i) => ({ v, i })), (x) => x.v);
  return [...m.entries()].sort((a, b) => a[0].i - b[0].i).map(([, p]) => p);
};

describe('classifyAbc', () => {
  it('80% e 95% exatos ficam dentro da classe; um centavo a mais já é a próxima', () => {
    expect(classes([50, 30, 15, 5]).map((p) => p.class)).toEqual(['A', 'A', 'B', 'C']);
    expect(classes([5000, 3001, 1499, 500]).map((p) => p.class)).toEqual(['A', 'B', 'B', 'C']);
    expect(classes([5000, 3000, 1501, 499]).map((p) => p.class)).toEqual(['A', 'A', 'C', 'C']);
  });

  it('ordena do maior para o menor, com ranking, participação e acumulado arredondado para cima', () => {
    const p = classes([10, 70, 20]);
    expect(p.map((x) => x.rank)).toEqual([3, 1, 2]);
    expect(p[1]).toMatchObject({ share: 0.7, cumulative: 0.7, class: 'A' });
    expect(p[2]).toMatchObject({ cumulative: 0.9, class: 'B' });
    expect(p[0]).toMatchObject({ cumulative: 1, class: 'C' });
    // 1/3 = 33,33…% → mostra 33,4% (nunca menos que o real)
    expect(classes([1, 1, 1])[0]!.cumulative).toBe(0.334);
  });

  it('o primeiro é sempre A, mesmo passando de 80% sozinho', () => {
    expect(classes([90, 5, 5]).map((p) => p.class)).toEqual(['A', 'B', 'C']);
  });
});
