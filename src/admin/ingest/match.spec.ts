import { matchShoot, publishable, type PhotoIn } from './match.js';

let n = 0;
const at = (min: number) => new Date(Date.UTC(2026, 8, 18, 9, min));
const photo = (min: number | null, extra: Partial<PhotoIn> = {}): PhotoIn => ({
  id: `p${++n}`,
  filename: `IMG_${n}.jpg`,
  capturedAt: min === null ? null : at(min),
  decodeKind: 'NONE',
  decodedChildId: null,
  decodedUnknown: false,
  overrideChildId: null,
  overrideNotAnchor: false,
  excluded: false,
  runApproved: false,
  ...extra,
});
const card = (min: number, child: string, kind = 'QR') => photo(min, { decodeKind: kind, decodedChildId: child });

describe('matchShoot', () => {
  it('gives each photo to the most recent card before it, by capture time not upload order', () => {
    const photos = [photo(4), card(0, 'amy'), photo(1), card(3, 'ben'), photo(2), photo(5)];
    const runs = matchShoot(photos);
    expect(runs.map((r) => [r.childId, r.photoIds.length])).toEqual([['amy', 2], ['ben', 2]]);
    expect(runs.every(publishable)).toBe(true);
  });

  it('flags photos before the first card, unknown and unreadable cards, and never publishes them', () => {
    const runs = matchShoot([photo(0), photo(1, { decodeKind: 'QR', decodedUnknown: true }), photo(2), photo(3, { decodeKind: 'UNREADABLE' }), photo(4)]);
    expect(runs.map((r) => r.flags)).toEqual([['NO_CARD'], ['UNKNOWN_CODE'], ['UNREADABLE_CARD']]);
    expect(runs.some(publishable)).toBe(false);
  });

  it('flags OCR reads, duplicates and empty runs until staff approve', () => {
    const runs = matchShoot([card(0, 'amy', 'OCR'), photo(1), card(2, 'ben'), card(3, 'ben'), photo(4)]);
    expect(runs.map((r) => r.flags)).toEqual([['READ_BY_OCR'], ['DUPLICATE_CHILD', 'NO_PHOTOS'], ['DUPLICATE_CHILD']]);
    const ok = matchShoot([card(0, 'amy', 'OCR'), photo(1)].map((p, i) => (i === 0 ? { ...p, runApproved: true } : p)));
    expect(ok[0].flags).toEqual([]);
  });

  it('respects staff overrides: excluded photos, "not a card", and manual cards', () => {
    const wrong = card(1, 'ben');
    const runs = matchShoot([photo(0, { overrideChildId: 'amy' }), { ...wrong, overrideNotAnchor: true }, photo(2, { excluded: true }), photo(3)]);
    expect(runs).toEqual([expect.objectContaining({ childId: 'amy', how: 'MANUAL', photoIds: [wrong.id, `p${n}`], flags: [] })]);
  });

  it('flags runs far longer or shorter than typical', () => {
    const photos = [];
    for (const [i, size] of [5, 5, 5, 5, 40, 1].entries()) {
      photos.push(card(i * 100, `c${i}`));
      for (let k = 1; k <= size; k++) photos.push(photo(i * 100 + k));
    }
    expect(matchShoot(photos).map((r) => r.flags)).toEqual([[], [], [], [], ['LONG_RUN'], ['SHORT_RUN']]);
  });

  it('puts photos without a capture time last, in natural filename order', () => {
    const a = photo(null, { filename: 'IMG_10.jpg' });
    const b = photo(null, { filename: 'IMG_9.jpg' });
    expect(matchShoot([a, card(0, 'amy'), b])[0].photoIds).toEqual([b.id, a.id]);
  });
});
