import { displayNameFor } from './display-name';

/**
 * Shared by registration, the join flow and the trainer roster, so the fallback
 * behaviour has to be the same in all three: a profile with no name shows the
 * email rather than an empty string.
 */
describe('displayNameFor', () => {
  it('joins both names when both are set', () => {
    expect(displayNameFor({ firstName: 'Sam', lastName: 'Smith' }, 'a@b.com')).toBe('Sam Smith');
  });

  it('uses whichever single name is set, with no stray space', () => {
    expect(displayNameFor({ firstName: 'Sam', lastName: null }, 'a@b.com')).toBe('Sam');
    expect(displayNameFor({ firstName: null, lastName: 'Smith' }, 'a@b.com')).toBe('Smith');
  });

  it('falls back when neither is set', () => {
    expect(displayNameFor({ firstName: null, lastName: null }, 'a@b.com')).toBe('a@b.com');
    expect(displayNameFor({}, 'a@b.com')).toBe('a@b.com');
  });

  it('treats undefined the same as null', () => {
    expect(displayNameFor({ firstName: undefined, lastName: 'Smith' }, 'a@b.com')).toBe('Smith');
  });

  it('falls back on whitespace rather than storing a blank name', () => {
    // A display name of ' ' passes a NOT NULL column and shows as nothing.
    expect(displayNameFor({ firstName: '   ', lastName: '' }, 'a@b.com')).toBe('a@b.com');
  });

  it('keeps a name that merely contains spaces', () => {
    expect(displayNameFor({ firstName: 'Mary Jane', lastName: 'Watson' }, 'a@b.com')).toBe(
      'Mary Jane Watson',
    );
  });

  it('does not trim the parts it keeps', () => {
    // Deliberate: normalising input is the DTO's job, not this helper's.
    expect(displayNameFor({ firstName: ' Sam ', lastName: null }, 'a@b.com')).toBe(' Sam ');
  });
});
