import { deflateSync, inflateSync } from 'node:zlib';

/**
 * A minimal PNG codec, written against `node:zlib` rather than pulling in
 * `pngjs`.
 *
 * The harness needs exactly two things — write an 8-bit truecolour PNG, read one
 * back — and PNG's non-interlaced 8-bit path is small enough that a dependency
 * is not worth the supply-chain surface. Everything outside that path (16-bit,
 * palettes, Adam7, ancillary chunks) is rejected rather than half-supported, so
 * a file this module cannot handle fails loudly instead of decoding to garbage.
 *
 * IDAT is a zlib stream, which is what `deflateSync`/`inflateSync` produce and
 * consume natively, so the compression layer is free.
 */

/** RGBA8, tightly packed, **row 0 at the top**. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/**
 * Encodes RGBA8 as an 8-bit truecolour PNG, dropping the alpha channel.
 *
 * Every image this harness writes is an opaque frame, so storing alpha would add
 * a third to the file size of a checked-in baseline in exchange for a constant
 * 255. Callers that need transparency do not exist here.
 */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  if (data.length < width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} bytes, got ${data.length}`);
  }

  const stride = width * 3;
  // One extra byte per scanline for the filter type, as the format requires.
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  const current = Buffer.allocUnsafe(stride);
  const previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = x * 3;
      current[dst] = data[src];
      current[dst + 1] = data[src + 1];
      current[dst + 2] = data[src + 2];
    }

    // Adaptive filtering, chosen by the minimum-sum-of-absolute-differences
    // heuristic the PNG spec itself recommends. On photographic content this is
    // worth roughly a quarter of the file size over filter 0, which is the
    // difference between a baseline set that is pleasant to keep in git and one
    // that is not.
    let bestFilter = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const value = filterByte(current, previous, filter, i, 3);
        // Signed magnitude: bytes near 255 are small negative deltas, and deflate
        // exploits them just as well as bytes near 0.
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
      }
    }

    const rowStart = y * (stride + 1);
    raw[rowStart] = bestFilter;
    for (let i = 0; i < stride; i++) {
      raw[rowStart + 1 + i] = filterByte(current, previous, bestFilter, i, 3);
    }

    current.copy(previous);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Decodes an 8-bit non-interlaced truecolour PNG (with or without alpha). */
export function decodePng(file: Buffer): RgbaImage {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (file[i] !== SIGNATURE[i]) throw new Error('decodePng: not a PNG');
  }

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];

  let offset = SIGNATURE.length;
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    offset += length + 12; // length + type + body + CRC

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8) throw new Error(`decodePng: unsupported bit depth ${bitDepth}`);
      if (interlace !== 0) throw new Error('decodePng: interlaced PNGs are not supported');
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else throw new Error(`decodePng: unsupported colour type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (channels === 0) throw new Error('decodePng: no IHDR chunk');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prior = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i];
      const a = i >= channels ? line[i - channels] : 0;
      const b = prior[i];
      const c = i >= channels ? prior[i - channels] : 0;
      switch (filter) {
        case 0: line[i] = x; break;
        case 1: line[i] = (x + a) & 0xff; break;
        case 2: line[i] = (x + b) & 0xff; break;
        case 3: line[i] = (x + ((a + b) >> 1)) & 0xff; break;
        case 4: line[i] = (x + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`decodePng: unknown filter type ${filter} on row ${y}`);
      }
    }

    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = line[src];
      out[dst + 1] = line[src + 1];
      out[dst + 2] = line[src + 2];
      out[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
    prior.set(line);
  }

  return { width, height, data: out };
}

/** Applies one PNG filter to byte `i` of an unfiltered scanline. */
function filterByte(
  current: Uint8Array,
  previous: Uint8Array,
  filter: number,
  i: number,
  channels: number,
): number {
  const a = i >= channels ? current[i - channels] : 0;
  const b = previous[i];
  const c = i >= channels ? previous[i - channels] : 0;
  switch (filter) {
    case 0: return current[i];
    case 1: return (current[i] - a) & 0xff;
    case 2: return (current[i] - b) & 0xff;
    case 3: return (current[i] - ((a + b) >> 1)) & 0xff;
    default: return (current[i] - paeth(a, b, c)) & 0xff;
  }
}

/** The PNG Paeth predictor: whichever of left/above/upper-left is closest to p. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
