import { parseClassList } from './admin.controller.js';

describe('parseClassList', () => {
  it('reads rows and skips a header', () => {
    expect(parseClassList('First name,Last name,Class\nEmma, Smith ,Year 2 Oak\r\n\nLeo,Smith,Reception')).toEqual([
      { firstName: 'Emma', lastName: 'Smith', className: 'Year 2 Oak' },
      { firstName: 'Leo', lastName: 'Smith', className: 'Reception' },
    ]);
  });
  it('names the bad line', () => expect(parseClassList('Emma,Smith,Oak\nLeo,Smith')).toEqual({ error: expect.stringContaining('Line 2') }));
  it('rejects an empty file', () => expect(parseClassList('first,last,class\n')).toHaveProperty('error'));
});
