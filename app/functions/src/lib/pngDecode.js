// Minimal PNG decoder, the counterpart of png.js: 8-bit RGBA or RGB, no
// interlace, on node:zlib. It reads the rasters this platform wrote itself
// (src/tiles), so it needs no image dependency either; the five scanline
// filters are handled anyway, so a raster re-encoded by another tool still reads.
import { inflateSync } from "node:zlib";
import { crc32 } from "./png.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A tile is 256 x 256: refuse anything bigger than a 4096 x 4096 image before allocating.
const DEFAULT_MAX_PIXELS = 4096 * 4096;

export class PngError extends Error {
  constructor(message) {
    super(message);
    this.name = "PngError";
  }
}

/** Chunks of a PNG, CRC checked. */
function readChunks(png) {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw new PngError("not a PNG");
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new PngError("truncated chunk");
    const length = png.readUInt32BE(offset);
    const end = offset + 8 + length;
    if (end + 4 > png.length) throw new PngError("truncated chunk");
    const type = png.toString("latin1", offset + 4, offset + 8);
    if (png.readUInt32BE(end) !== crc32(png.subarray(offset + 4, end))) throw new PngError(`bad CRC in ${type}`);
    chunks.push({ type, data: png.subarray(offset + 8, end) });
    offset = end + 4;
    if (type === "IEND") break;
  }
  return chunks;
}

/** `{ key: value }` of the `tEXt` chunks. */
function textOf(chunks) {
  const text = {};
  for (const { type, data } of chunks) {
    if (type !== "tEXt") continue;
    const nul = data.indexOf(0);
    if (nul > 0) text[data.toString("latin1", 0, nul)] = data.toString("latin1", nul + 1);
  }
  return text;
}

/** The `tEXt` chunks of a PNG, without inflating the image (the tile reader only needs the version). */
export function readPngText(png) {
  return textOf(readChunks(png));
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undoes the scanline filters; `bpp` is the number of bytes per pixel. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = y > 0 ? out[dst - stride + i] : 0;
      const upLeft = y > 0 && i >= bpp ? out[dst - stride + i - bpp] : 0;
      let predictor;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = (left + up) >> 1;
          break;
        case 4:
          predictor = paeth(left, up, upLeft);
          break;
        default:
          throw new PngError(`unknown filter ${filter}`);
      }
      out[dst + i] = (raw[src + i] + predictor) & 0xff;
    }
  }
  return out;
}

/**
 * @param {Buffer} png
 * @param {object} [options]
 * @param {number} [options.maxPixels]
 * @returns {{ width: number, height: number, rgba: Uint8Array, text: Record<string, string> }}
 * @throws {PngError} on anything that is not a plain 8-bit RGB/RGBA PNG
 */
export function decodePng(png, { maxPixels = DEFAULT_MAX_PIXELS } = {}) {
  const chunks = readChunks(png);
  const header = chunks[0];
  if (header?.type !== "IHDR" || header.data.length !== 13) throw new PngError("missing IHDR");
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const [depth, colorType, , , interlace] = header.data.subarray(8);
  if (width < 1 || height < 1 || width * height > maxPixels) throw new PngError("unsupported size");
  if (depth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) throw new PngError("unsupported PNG format");
  const bpp = colorType === 6 ? 4 : 3;

  const compressed = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  const expected = (width * bpp + 1) * height;
  let raw;
  try {
    raw = inflateSync(compressed, { maxOutputLength: expected });
  } catch {
    throw new PngError("cannot inflate the image data");
  }
  if (raw.length !== expected) throw new PngError("image data has the wrong length");

  let pixels = unfilter(raw, width, height, bpp);
  if (bpp === 3) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      pixels.copy(rgba, i * 4, i * 3, i * 3 + 3);
      rgba[i * 4 + 3] = 0xff;
    }
    pixels = rgba;
  }
  return { width, height, rgba: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length), text: textOf(chunks) };
}
