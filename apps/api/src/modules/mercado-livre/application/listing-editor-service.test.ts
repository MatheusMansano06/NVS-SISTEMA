import { describe, expect, it } from 'vitest';
import { decodeImage, firstNumber, imageKind, mergeAttributes } from './listing-editor-service.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

describe('upload de imagem', () => {
  it('reconhece pela assinatura, não pelo nome', () => {
    expect(imageKind(png)).toBe('image/png');
    expect(imageKind(jpg)).toBe('image/jpeg');
    expect(imageKind(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });
  it('recusa base64 inválido, conteúdo que não é imagem e tipo trocado', () => {
    expect(decodeImage('image/png', png.toString('base64')).length).toBe(png.length);
    expect(() => decodeImage('image/png', 'não é base64!!')).toThrow('Arquivo inválido');
    expect(() => decodeImage('image/png', Buffer.from('#!/bin/sh').toString('base64'))).toThrow('não é uma imagem');
    expect(() => decodeImage('image/png', jpg.toString('base64'))).toThrow('não bate');
  });
});

describe('editor', () => {
  it('mantém value_id dos atributos não alterados', () => {
    expect(mergeAttributes([{ id: 'BRAND', value_id: '1', value_name: 'X' }, { id: 'MODEL', value_name: 'A' }], { MODEL: 'B' })).toEqual([
      { id: 'BRAND', value_id: '1' },
      { id: 'MODEL', value_name: 'B' },
    ]);
    expect(firstNumber('28 cm')).toBe(28);
  });
});
