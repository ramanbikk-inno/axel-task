import { ChildLike, findSimilarChildren, normalizeChildName } from './child-similarity';

const child = (id: string, displayName: string, birthDate: string | null): ChildLike => ({
  id,
  displayName,
  birthDate,
});

describe('normalizeChildName', () => {
  it('ignores case, surrounding space and repeated inner space', () => {
    expect(normalizeChildName('  Maya   Smith ')).toBe('maya smith');
    expect(normalizeChildName('MAYA SMITH')).toBe('maya smith');
  });
});

describe('findSimilarChildren', () => {
  const existing = [
    child('p1', 'Alexander Smith', '2014-08-01'),
    child('p2', 'Maya Smith', '2016-02-11'),
  ];

  it('flags an exact name + birth date match as exact', () => {
    const [match] = findSimilarChildren(existing, {
      displayName: 'maya  SMITH',
      birthDate: '2016-02-11',
    });

    expect(match).toEqual({
      profileId: 'p2',
      displayName: 'Maya Smith',
      birthDate: '2016-02-11',
      exact: true,
    });
  });

  it('warns on a nickname of an existing child without calling it exact', () => {
    // The case the old exact-compare missed entirely: same kid, shorter name.
    const matches = findSimilarChildren(existing, {
      displayName: 'Alex Smith',
      birthDate: '2014-08-01',
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ profileId: 'p1', exact: false });
  });

  it('warns when the birth date is close but not equal', () => {
    const matches = findSimilarChildren(existing, {
      displayName: 'Maya Smith',
      birthDate: '2016-02-12',
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ profileId: 'p2', exact: false });
  });

  it('does not warn once the birth dates are more than a year apart', () => {
    expect(
      findSimilarChildren(existing, { displayName: 'Maya Smith', birthDate: '2019-02-11' }),
    ).toEqual([]);
  });

  it('does not treat a two-character prefix as a nickname', () => {
    // "Al" would match half a roster; the floor is three characters.
    expect(findSimilarChildren(existing, { displayName: 'Al', birthDate: '2014-08-01' })).toEqual(
      [],
    );
  });

  it('matches on name alone when either birth date is unknown', () => {
    const matches = findSimilarChildren([child('p3', 'Sam Jones', null)], {
      displayName: 'Sam Jones',
      birthDate: '2015-01-01',
    });

    expect(matches).toHaveLength(1);
    // Not exact: a null birth date is not the same value as a real one.
    expect(matches[0].exact).toBe(false);
  });

  it('excludes the profile being renamed, so it cannot match itself', () => {
    expect(
      findSimilarChildren(existing, { displayName: 'Maya Smith', birthDate: '2016-02-11' }, 'p2'),
    ).toEqual([]);
  });

  it('returns nothing for an unrelated name', () => {
    expect(
      findSimilarChildren(existing, { displayName: 'Jordan Lee', birthDate: '2014-08-01' }),
    ).toEqual([]);
  });
});
