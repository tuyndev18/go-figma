/** Detect an image format from its magic bytes (Figma stores PNG, JPEG, GIF, WebP). */
export function sniffImageType(bytes: Uint8Array): { mimeType: string; extension: string } {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { mimeType: "image/png", extension: "png" };
  if (starts(0xff, 0xd8, 0xff)) return { mimeType: "image/jpeg", extension: "jpg" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { mimeType: "image/gif", extension: "gif" };
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return { mimeType: "application/octet-stream", extension: "bin" };
}

/** Read pixel dimensions from an image header (PNG, JPEG, GIF, WebP); null if unrecognised. */
export function sniffImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const u16be = (i: number) => (bytes[i] << 8) | bytes[i + 1];
  const u16le = (i: number) => bytes[i] | (bytes[i + 1] << 8);
  const u24le = (i: number) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
  const u32be = (i: number) => ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
  const { extension } = sniffImageType(bytes);
  switch (extension) {
    case "png":
      return bytes.length >= 24 ? { width: u32be(16), height: u32be(20) } : null;
    case "gif":
      return bytes.length >= 10 ? { width: u16le(6), height: u16le(8) } : null;
    case "jpg": {
      // Walk segments until a start-of-frame marker (SOF0–SOF15, excluding DHT/JPG/DAC).
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: u16be(i + 7), height: u16be(i + 5) };
        }
        i += 2 + u16be(i + 2);
      }
      return null;
    }
    case "webp": {
      if (bytes.length < 30) return null;
      const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
      if (chunk === "VP8L") {
        const b = (i: number) => bytes[21 + i];
        return { width: 1 + (((b(1) & 0x3f) << 8) | b(0)), height: 1 + (((b(3) & 0x0f) << 10) | (b(2) << 2) | ((b(1) & 0xc0) >> 6)) };
      }
      if (chunk === "VP8X") return { width: 1 + u24le(24), height: 1 + u24le(27) };
      return null;
    }
    default:
      return null;
  }
}
