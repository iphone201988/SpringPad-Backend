import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const require = createRequire(import.meta.url);

// Load the decoders from node_modules, never from a CDN at runtime.
prepareZXingModule({
  overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')).buffer as ArrayBuffer },
  fireImmediately: true,
});
const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

let ocr: Promise<Worker> | undefined;
const ocrWorker = () =>
  (ocr ??= createWorker('eng', 1, { langPath: LANG_PATH, gzip: true }).then(async (w) => {
    await w.setParameters({ tessedit_char_whitelist: 'SP-0123456789ABCDEFGHJKMNPQRSTVWXYZ' });
    return w;
  }));

/** Codes look like SP-XXXX-XXXX-XXXX; OCR text is searched for anything that shape. */
const CODE_IN_TEXT = /S\s*P[\s-]*([0-9A-Z]{4})[\s-]*([0-9A-Z]{4})[\s-]*([0-9A-Z]{4})/g;

export type Decoded =
  | { kind: 'QR'; text: string }
  | { kind: 'OCR'; candidates: string[] } // possible codes read from the printed text; validated by the caller
  | { kind: 'UNREADABLE' } // a QR symbol is in the shot but couldn't be read, and OCR found nothing
  | { kind: 'NONE' };

/**
 * Looks for a code card in a photo. QR first (fast, exact); OCR only when ZXing saw a QR symbol it couldn't
 * decode — so ordinary portraits never pay for OCR.
 * ponytail: runs inline at upload (~0.2–1 s/photo); move to a worker queue if shoot uploads start timing out.
 */
export async function decodeCard(file: Buffer): Promise<Decoded> {
  // 2000 px is plenty for a card held at chest height and keeps ZXing fast on 24 MP masters.
  const { data, info } = await sharp(file).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const found = await readBarcodes(
    { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, colorSpace: 'srgb' },
    { formats: ['QRCode'], tryHarder: true, returnErrors: true, maxNumberOfSymbols: 2 },
  );
  const ok = found.find((b) => b.isValid && b.text);
  if (ok) return { kind: 'QR', text: ok.text };
  if (!found.length) return { kind: 'NONE' };

  // A card is in shot but its QR didn't decode: read the printed code. Reading only a strip next to the QR is far
  // more reliable than the whole photo. Our cards print the code to the right of the QR (components/admin/CodeCards),
  // so that strip goes first; below and left cover other layouts; the whole photo is the last resort.
  const { topLeft, bottomRight } = found[0].position;
  const [x0, y0, x1, y1] = [topLeft.x, topLeft.y, bottomRight.x, bottomRight.y].map(Math.round);
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const strips = [
    { left: x1, top: y0 - h / 4, right: x1 + 5 * w, bottom: y1 + h / 4 }, // right of the QR
    { left: x0 - 2 * w, top: y1, right: x1 + 3 * w, bottom: y1 + 1.5 * h }, // below it
    { left: x0 - 5 * w, top: y0 - h / 4, right: x0, bottom: y1 + h / 4 }, // left of it
  ];
  const raw = { raw: { width: info.width, height: info.height, channels: 4 as const } };
  for (const r of strips) {
    const left = Math.max(0, Math.round(r.left)), top = Math.max(0, Math.round(r.top));
    const width = Math.min(info.width, Math.round(r.right)) - left, height = Math.min(info.height, Math.round(r.bottom)) - top;
    if (width < 20 || height < 20) continue;
    const strip = await sharp(data, raw).extract({ left, top, width, height }).resize({ width: Math.min(2400, width * 2) }).grayscale().normalise().png().toBuffer();
    const candidates = codesIn((await (await ocrWorker()).recognize(strip)).data.text);
    if (candidates.length) return { kind: 'OCR', candidates };
  }
  const grey = await sharp(file).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).grayscale().normalise().toBuffer();
  const candidates = codesIn((await (await ocrWorker()).recognize(grey)).data.text);
  return candidates.length ? { kind: 'OCR', candidates } : { kind: 'UNREADABLE' };
}

const codesIn = (text: string) => [...text.toUpperCase().matchAll(CODE_IN_TEXT)].map((m) => `SP-${m[1]}-${m[2]}-${m[3]}`);

// Characters text recognition confuses on our cards (O/I/L are already folded by normalizeChildCode).
const LOOKALIKE: Record<string, string> = { '0': '0QD', Q: 'Q0', D: 'D0', '8': '8BS', B: 'B8', S: 'S58', '5': '5S', '2': '2Z', Z: 'Z2', '7': '7T', T: 'T7', '4': '4A', A: 'A4', '6': '6G', G: 'G6', '9': '9Y', Y: 'Y9' };

/**
 * Every reading of an OCR'd code if look-alike characters were misread (the read itself comes first). Capped,
 * because each variant is only a guess to check against the shoot's issued codes — 60-bit random codes make a
 * wrong match practically impossible, and OCR matches still go to human review.
 */
export function lookalikeVariants(code: string, cap = 4096): string[] {
  const chars = code.replace(/^SP-/, '').replace(/-/g, '').split('');
  let out = [''];
  for (const c of chars) {
    const alts = LOOKALIKE[c] ?? c;
    if (out.length * alts.length > cap) return out.map((v) => v + chars.slice(v.length).join('')).map(fmt); // stop branching
    out = out.flatMap((v) => alts.split('').map((a) => v + a));
  }
  return out.map(fmt);
}
const fmt = (s: string) => `SP-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
