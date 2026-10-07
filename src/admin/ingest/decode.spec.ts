import { cardPhoto, portrait } from './card-fixture.js';
import { decodeCard, lookalikeVariants } from './decode.js';

describe('decodeCard', () => {
  it('reads the QR on a card', async () => expect(await decodeCard(await cardPhoto('SP-K73Q-F9XM-2CAB'))).toEqual({ kind: 'QR', text: 'SP-K73Q-F9XM-2CAB' }));
  it('falls back to the printed code when the QR is damaged', async () => {
    const r = await decodeCard(await cardPhoto('SP-K73Q-F9XM-2CAB', { damageQr: true }));
    expect(r.kind).toBe('OCR');
    expect(r.kind === 'OCR' && r.candidates.some((c) => lookalikeVariants(c).includes('SP-K73Q-F9XM-2CAB'))).toBe(true);
  });
  it('ignores ordinary portraits', async () => expect(await decodeCard(await portrait())).toEqual({ kind: 'NONE' }));
}, 60_000);

describe('lookalikeVariants', () => {
  it('includes the read itself first, and fixes common misreads', () => {
    const v = lookalikeVariants('SP-P8FC-QD2W-HQTK');
    expect(v[0]).toBe('SP-P8FC-QD2W-HQTK');
    expect(v).toContain('SP-P8FC-QD2W-HQ7K'); // 7 read as T
    expect(lookalikeVariants('SP-BRYR-3CZ5-9HBJ')).toContain('SP-BR9R-3CZ5-9HBJ'); // 9 read as Y
  });
  it('stays bounded however ambiguous the read', () => expect(lookalikeVariants('SP-8888-8888-8888').length).toBeLessThanOrEqual(4096));
});
