import bwipjs from 'bwip-js';
import { describe, expect, it } from 'vitest';
import { ean13Modules, internalEan } from '@nvs/shared';

/** O desenho do navegador (ean13Modules) tem de bater barra a barra com o bwip-js, que gera as etiquetas em PDF. */
describe('ean13Modules', () => {
  it.each(['4006381333931', internalEan(1), internalEan(4_321_987), internalEan(9_999_999_999)])('bate com o bwip-js para %s', (code) => {
    const sbs = (bwipjs.raw({ bcid: 'ean13', text: code })[0] as { sbs: number[] }).sbs;
    const fromBwip = sbs.map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(w)).join('');
    expect(ean13Modules(code)).toBe(fromBwip);
  });
});
