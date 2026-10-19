import { describe, expect, it } from 'vitest';
import { gs1CheckDigit, internalEan, isRestrictedCirculation, isValidGtin, officialGtinProblem } from './ean.js';

describe('EAN / GS1', () => {
  it('calcula o dígito verificador de GTINs reais', () => {
    expect(gs1CheckDigit('400638133393')).toBe(1); // 4006381333931 (exemplo da GS1)
    expect(isValidGtin('4006381333931')).toBe(true);
    expect(isValidGtin('4006381333932')).toBe(false);
    expect(isValidGtin('96385074')).toBe(true); // GTIN-8
  });

  it('gera código interno de circulação restrita (20…) com verificador válido', () => {
    const c = internalEan(1);
    expect(c).toBe('2000000000015');
    expect(c).toHaveLength(13);
    expect(isValidGtin(c)).toBe(true);
    expect(isRestrictedCirculation(c)).toBe(true);
    expect(isValidGtin(internalEan(9_999_999_999))).toBe(true);
    expect(() => internalEan(0)).toThrow();
  });

  it('recusa como GTIN oficial um código interno ou com verificador errado', () => {
    expect(officialGtinProblem('4006381333931')).toBeNull();
    expect(officialGtinProblem('2000000000015')).toMatch(/internos/);
    expect(officialGtinProblem('4006381333932')).toMatch(/verificador/);
    expect(officialGtinProblem('12345')).toMatch(/dígitos/);
  });
});
