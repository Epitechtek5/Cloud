import { describe, expect, it } from 'vitest';
import { readPngVersion } from './pngVersion';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A chunk as the renderer writes it (the CRC is not checked by the reader, zeros are enough). */
function chunk(type: string, data: number[] | string): number[] {
  const bytes = typeof data === 'string' ? [...data].map((c) => c.charCodeAt(0)) : data;
  const n = bytes.length;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...[...type].map((c) => c.charCodeAt(0)), ...bytes, 0, 0, 0, 0];
}
const text = (key: string, value: string) => chunk('tEXt', `${key}\0${value}`);
const png = (...chunks: number[][]) => new Uint8Array([...SIGNATURE, ...chunk('IHDR', new Array(13).fill(0)), ...chunks.flat(), ...chunk('IEND', [])]);

describe('readPngVersion', () => {
  it('reads the Tile-Version text chunk written by the renderer', () => {
    expect(readPngVersion(png(text('Tile-Version', '1700000000123'), chunk('IDAT', [1, 2, 3])))).toBe(1_700_000_000_123);
  });

  it('skips the other text chunks', () => {
    expect(readPngVersion(png(text('Title', 'pixel canvas'), text('Tile-Version', '42'), chunk('IDAT', [])))).toBe(42);
  });

  it('works on a view into a larger buffer', () => {
    const bytes = png(text('Tile-Version', '7'));
    const shifted = new Uint8Array(bytes.length + 5);
    shifted.set(bytes, 5);
    expect(readPngVersion(shifted.subarray(5))).toBe(7);
  });

  it('refuses a PNG without a version, or with one written after the image data', () => {
    expect(() => readPngVersion(png(chunk('IDAT', [1])))).toThrow(/No Tile-Version/);
    expect(() => readPngVersion(png(chunk('IDAT', [1]), text('Tile-Version', '1')))).toThrow(/No Tile-Version/);
  });

  it.each(['', 'abc', '-1', '1.5', '9'.repeat(17)])('refuses an invalid version (%j)', (v) => {
    expect(() => readPngVersion(png(text('Tile-Version', v)))).toThrow(/Invalid Tile-Version/);
  });

  it('refuses bytes that are not a PNG, and a truncated chunk', () => {
    expect(() => readPngVersion(new TextEncoder().encode('<!doctype html>'))).toThrow(/Not a PNG/);
    const full = png(text('Tile-Version', '1700000000123'));
    expect(() => readPngVersion(full.subarray(0, full.length - 30))).toThrow(/No Tile-Version/);
  });
});
