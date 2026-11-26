// A minimal PNG reader for screenshot pixel checks (8-bit RGB/RGBA, non-interlaced, as
// Chromium writes them), so the browser checks need no image dependency.
import { inflateSync } from "node:zlib";

export interface Pixels {
  width: number;
  height: number;
  at(x: number, y: number): [number, number, number];
}

export function readPng(png: Buffer): Pixels {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const colorType = body[9];
      if (body[8] !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) throw new Error("unsupported PNG");
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      data.push(body);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i += 1) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const left = i >= channels ? (out[y * stride + i - channels] ?? 0) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + i] ?? 0) : 0;
      const upLeft = y > 0 && i >= channels ? (out[(y - 1) * stride + i - channels] ?? 0) : 0;
      let value = x;
      if (filter === 1) value = x + left;
      else if (filter === 2) value = x + up;
      else if (filter === 3) value = x + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[y * stride + i] = value & 0xff;
    }
  }
  return {
    width,
    height,
    at(x, y) {
      const i = y * stride + x * channels;
      return [out[i] ?? 0, out[i + 1] ?? 0, out[i + 2] ?? 0];
    },
  };
}
