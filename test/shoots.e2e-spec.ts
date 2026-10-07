// Shoot ingestion: upload → card reading → matching → review → publish → the right parent sees the right photos.
import { cardPhoto, portrait } from '../src/admin/ingest/card-fixture.js';
import { call, parentWithCode, run, staffSession, upload } from './helpers.js';

const at = (min: number) => new Date(Date.UTC(2026, 8, 18, 9, min));

describe('shoots', () => {
  it('matches photos to children by card, holds flagged runs back, and publishes only to the right parent', async () => {
    const staff = await staffSession('STAFF');
    const school = (await call('POST', '/admin/schools', { name: `Shoot E2E ${run}` }, staff)).body.id;
    await call('POST', `/admin/schools/${school}/children/import`, { academicYear: '2026-27', csv: 'Amy,Lee,Year 3\nBen,Lee,Year 1' }, staff);
    const kids = (await call('GET', `/admin/schools/${school}/children?year=2026-27`, undefined, staff)).body.children;
    const shoot = (await call('POST', `/admin/schools/${school}/shoots`, { name: 'Autumn', takenOn: '2026-09-18', academicYear: '2026-27' }, staff)).body.id;
    const other = (await call('POST', `/admin/schools/${school}/shoots`, { name: 'Spring', takenOn: '2027-03-01', academicYear: '2026-27' }, staff)).body.id;
    const ids = kids.map((k: { id: string }) => k.id);
    const codes = (await call('POST', '/admin/codes', { shootId: shoot, childIds: ids }, staff)).body as { name: string; code: string; childId: string }[];
    const amy = codes.find((c) => c.name === 'Amy Lee')!;
    const ben = codes.find((c) => c.name === 'Ben Lee')!;
    // Ben also has a card for a different shoot at the same school; strict matching must not accept it here
    const benOther = ((await call('POST', '/admin/codes', { shootId: other, childIds: [ben.childId] }, staff)).body as { code: string }[])[0];

    // uploaded out of order on purpose: capture time decides
    const files: [Buffer, string, number][] = [
      [await portrait('#a07050'), 'IMG_0003.jpg', 3],
      [await cardPhoto(amy.code), 'IMG_0001.jpg', 1],
      [await portrait('#b08060'), 'IMG_0002.jpg', 2],
      [await cardPhoto(ben.code, { damageQr: true }), 'IMG_0004.jpg', 4], // QR unreadable → text recognition
      [await portrait('#906040'), 'IMG_0005.jpg', 5],
      [await cardPhoto(benOther.code), 'IMG_0006.jpg', 6], // wrong shoot's card
      [await portrait('#806030'), 'IMG_0007.jpg', 7],
      [await cardPhoto('SP-ZZZZ-ZZZZ-ZZZZ', { damageQr: true }), 'IMG_0008.jpg', 8], // a card we can see but not match
      [await portrait('#705020'), 'IMG_0009.jpg', 9],
    ];
    for (const [buf, name, min] of files) expect((await upload(`/admin/shoots/${shoot}/photos`, buf, name, at(min), staff)).status).toBe(201);
    expect((await upload(`/admin/shoots/${shoot}/photos`, files[0][0], 'again.jpg', at(9), staff)).body.duplicate).toBe(true);

    let view = (await call('GET', `/admin/shoots/${shoot}`, undefined, staff)).body;
    expect(view.runs.map((r: { child: { id: string } | null; photos: unknown[]; flags: string[] }) => [r.child?.id, r.photos.length, r.flags])).toEqual([
      [amy.childId, 2, []],
      [ben.childId, 1, ['READ_BY_OCR']],
      [undefined, 1, ['UNKNOWN_CODE']],
      [undefined, 1, ['UNREADABLE_CARD']], // never silently merged into the previous child's photos
    ]);

    expect((await call('POST', `/admin/shoots/${shoot}/publish`, undefined, staff)).body).toEqual({ published: 2 }); // Ben waits for review
    const benRun = view.runs[1];
    await call('PATCH', `/admin/photos/${benRun.anchor.id}`, { runApproved: true }, staff);
    await call('PATCH', `/admin/photos/${view.runs[2].anchor.id}`, { excluded: true }, staff); // staff drop the wrong-shoot card…
    await call('PATCH', `/admin/photos/${view.runs[2].photos[0].id}`, { excluded: true }, staff); // …and its photo
    expect((await call('POST', `/admin/shoots/${shoot}/publish`, undefined, staff)).body).toEqual({ published: 1 });
    expect((await call('POST', `/admin/shoots/${shoot}/publish`, undefined, staff)).body).toEqual({ published: 0 }); // idempotent

    // published photos can't be moved to another child
    view = (await call('GET', `/admin/shoots/${shoot}`, undefined, staff)).body;
    expect((await call('PATCH', `/admin/photos/${view.runs[0].photos[0].id}`, { excluded: true }, staff)).status).toBe(409);

    // Amy's parent sees Amy's 2 portraits — not her card photo, not Ben's
    const parent = await parentWithCode(`e2e-shoot-parent-${run}@example.com`, amy.code);
    const imgs = (await call('GET', `/children/${amy.childId}/images`, undefined, parent)).body;
    expect((imgs.images ?? imgs).length).toBe(2);
    expect((await call('GET', `/children/${ben.childId}/images`, undefined, parent)).status).toBe(404);
  });
}, 60_000);
