import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";

/** A real PNG with a randomly placed blue square; no answer in its metadata. */
export function syntheticImage() {
  const width = 32;
  const x = randomInt(2, 23);
  const y = randomInt(2, 23);
  const pixels = Buffer.alloc((1 + width * 3) * width, 255);
  for (let row = 0; row < width; row++) {
    pixels[row * (1 + width * 3)] = 0; // PNG filter: none
    for (let col = 0; col < width; col++) {
      if (col < x || col >= x + 8 || row < y || row >= y + 8) continue;
      const offset = row * (1 + width * 3) + 1 + col * 3;
      pixels[offset] = 0;
      pixels[offset + 1] = 0;
    }
  }
  function chunk(name: string, data: Buffer) {
    const payload = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header[8] = 8;
  header[9] = 2; // RGB
  const bytes = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { bytes, x, y };
}
