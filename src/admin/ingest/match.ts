// Turns a shoot's photos into runs: each card photo (the child holding their code) starts a run, and every
// photo after it belongs to that child until the next card — the same rule as the old spreadsheet process.
// Pure, so the whole shoot is re-matched from scratch whenever staff change something.

export type PhotoIn = {
  id: string;
  filename: string;
  capturedAt: Date | null;
  decodeKind: string; // QR | OCR | UNREADABLE | NONE
  decodedChildId: string | null;
  decodedUnknown: boolean;
  overrideChildId: string | null;
  overrideNotAnchor: boolean;
  excluded: boolean;
  runApproved: boolean;
};

export type Flag =
  | 'NO_CARD' // photos before the first card photo: whose are they?
  | 'UNKNOWN_CODE' // a code was read but it isn't one of this school's
  | 'UNREADABLE_CARD' // a card is in shot but neither QR nor text could be read
  | 'READ_BY_OCR' // matched from the printed text, not the QR — worth a glance
  | 'DUPLICATE_CHILD' // the same child has more than one run
  | 'NO_PHOTOS' // a card photo with nothing after it
  | 'LONG_RUN' // far more photos than a typical child
  | 'SHORT_RUN'; // far fewer

export type Run = {
  anchorId: string | null;
  childId: string | null;
  how: 'QR' | 'OCR' | 'MANUAL' | null;
  photoIds: string[]; // portraits only (the card photo is anchorId)
  flags: Flag[];
  approved: boolean;
};

/** Capture time first (photos without one go last), then filename in natural order (IMG_2 before IMG_10). */
export const captureOrder = (a: PhotoIn, b: PhotoIn) =>
  (a.capturedAt?.getTime() ?? Infinity) - (b.capturedAt?.getTime() ?? Infinity) || a.filename.localeCompare(b.filename, undefined, { numeric: true });

function anchorOf(p: PhotoIn): Pick<Run, 'childId' | 'how' | 'flags'> | null {
  if (p.overrideNotAnchor) return null;
  if (p.overrideChildId) return { childId: p.overrideChildId, how: 'MANUAL', flags: [] };
  if (p.decodedChildId) return { childId: p.decodedChildId, how: p.decodeKind === 'OCR' ? 'OCR' : 'QR', flags: p.decodeKind === 'OCR' ? ['READ_BY_OCR'] : [] };
  if (p.decodedUnknown) return { childId: null, how: null, flags: ['UNKNOWN_CODE'] };
  if (p.decodeKind === 'UNREADABLE') return { childId: null, how: null, flags: ['UNREADABLE_CARD'] };
  return null;
}

export function matchShoot(photos: PhotoIn[]): Run[] {
  const runs: Run[] = [];
  for (const p of [...photos].filter((p) => !p.excluded).sort(captureOrder)) {
    const a = anchorOf(p);
    if (a) runs.push({ anchorId: p.id, ...a, photoIds: [], approved: p.runApproved });
    else if (runs.length) runs.at(-1)!.photoIds.push(p.id);
    else runs.push({ anchorId: null, childId: null, how: null, photoIds: [p.id], flags: ['NO_CARD'], approved: false });
  }

  const sizes = runs.filter((r) => r.childId).map((r) => r.photoIds.length).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const perChild = new Map<string, number>();
  for (const r of runs) if (r.childId) perChild.set(r.childId, (perChild.get(r.childId) ?? 0) + 1);

  for (const r of runs) {
    if (!r.anchorId) continue;
    if (r.childId && perChild.get(r.childId)! > 1) r.flags.push('DUPLICATE_CHILD');
    if (!r.photoIds.length) r.flags.push('NO_PHOTOS');
    else if (median >= 3 && r.photoIds.length > Math.max(median * 3, median + 10)) r.flags.push('LONG_RUN');
    else if (median >= 3 && r.photoIds.length < median / 3) r.flags.push('SHORT_RUN');
    if (r.approved && r.childId) r.flags = []; // staff looked at it and said it's right
  }
  return runs;
}

/** Runs that can go to parents: a known child and nothing left to check. */
export const publishable = (r: Run) => !!r.childId && r.flags.length === 0;
