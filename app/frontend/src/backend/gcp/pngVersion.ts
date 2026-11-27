// Version of a tile raster, read from the PNG itself (docs/frontend-contract.md section 2).
//
// The tile renderer writes it as a `tEXt` chunk `Tile-Version` placed before the image data, so the
// image and its version are one object: the load balancer serves the bucket as is (no function to add
// a header), and a CDN copy can never pair the bytes of one render with the version of another.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KEY = 'Tile-Version';

const chunkType = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/**
 * Epoch ms of the newest pixel in the raster. Only the chunks before the image data are read (the
 * renderer writes the version there), without inflating anything. CRCs are not checked: the bytes come
 * from our own bucket over HTTPS, and a corrupted image fails to decode anyway.
 * @throws when the bytes are not a PNG or carry no valid version
 */
export function readPngVersion(png: Uint8Array): number {
  if (png.length < SIGNATURE.length || SIGNATURE.some((v, i) => png[i] !== v)) throw new Error('Not a PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = SIGNATURE.length;
  while (at + 8 <= png.length) {
    const length = view.getUint32(at);
    const type = chunkType(png, at + 4);
    const data = at + 8;
    if (data + length + 4 > png.length) break; // truncated
    if (type === 'IDAT' || type === 'IEND') break; // the version is written before the image
    if (type === 'tEXt') {
      const text = png.subarray(data, data + length);
      const sep = text.indexOf(0);
      if (sep > 0 && String.fromCharCode(...text.subarray(0, sep)) === KEY) {
        const value = String.fromCharCode(...text.subarray(sep + 1));
        const version = /^\d{1,16}$/.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(version)) throw new Error(`Invalid ${KEY} in the tile raster`);
        return version;
      }
    }
    at = data + length + 4; // data, then the CRC
  }
  throw new Error(`No ${KEY} in the tile raster`);
}
