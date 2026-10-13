import { describe, expect, it } from 'vitest';
import { pointInPolygon, polygonRings } from './flex-service.js';

const sp = [[-46.8, -23.7], [-46.4, -23.7], [-46.4, -23.4], [-46.8, -23.4], [-46.8, -23.7]];

describe('área de Flex', () => {
  it('ponto dentro e fora do polígono da zona', () => {
    expect(pointInPolygon(-46.63, -23.55, sp)).toBe(true); // centro de SP
    expect(pointInPolygon(-47.06, -22.9, sp)).toBe(false); // Campinas
  });
  it('lê Polygon e MultiPolygon do GeoJSON', () => {
    expect(polygonRings({ type: 'Polygon', coordinates: [sp] })).toEqual([sp]);
    expect(polygonRings({ type: 'MultiPolygon', coordinates: [[sp], [sp]] })).toHaveLength(2);
    expect(polygonRings(null)).toEqual([]);
  });
});
