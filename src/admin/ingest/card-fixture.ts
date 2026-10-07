// Test helper: a fake "child holding their card" photo (QR + printed code on a busy background).
import QRCode from 'qrcode';
import sharp, { type OverlayOptions } from 'sharp';

export async function cardPhoto(code: string, opts: { damageQr?: boolean } = {}) {
  const qr = await QRCode.toBuffer(code, { width: 320, margin: 1, errorCorrectionLevel: 'L' });
  const layers: OverlayOptions[] = [
    { input: Buffer.from('<svg width="1000" height="420"><rect width="1000" height="420" rx="24" fill="white"/></svg>'), left: 300, top: 500 },
    { input: qr, left: 330, top: 550 },
    { input: Buffer.from(`<svg width="620" height="90"><text x="0" y="64" font-family="Courier New, monospace" font-weight="bold" font-size="46">${code}</text></svg>`), left: 670, top: 660 },
  ];
  // A stripe through the middle of the QR: still detected as a QR symbol, but no longer decodable.
  if (opts.damageQr) layers.push({ input: Buffer.from('<svg width="320" height="70"><rect width="320" height="70" fill="black"/></svg>'), left: 330, top: 680 });
  return sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#7a9a6a' } }).composite(layers).jpeg({ quality: 90 }).toBuffer();
}

export const portrait = (shade = '#c08a6a') => sharp({ create: { width: 1600, height: 1200, channels: 3, background: shade } }).jpeg().toBuffer();
