import { weeklySegmentsOf } from './assignments.service';
import { Event } from './entities/event.entity';

// weeklySegmentsOf is the whole reason a cross-midnight event can be checked at
// all: it turns one absolute interval into the weekday windows availability is
// stored in. The arithmetic is easy to get subtly wrong (floor on the start,
// ceil on the end, a cut at every UTC midnight), and every caller trusts it, so
// it is pinned here rather than only through the e2e assignment flow.

const MINUTES_PER_DAY = 24 * 60;

/** Only startsAt/endsAt are read; the rest of the row is irrelevant here. */
function eventOver(startsAt: string, endsAt: string): Event {
  return { startsAt: new Date(startsAt), endsAt: new Date(endsAt) } as unknown as Event;
}

// 2026-09-07 is a Monday, so dayOfWeek 1 throughout.
const MON = '2026-09-07';
const TUE = '2026-09-08';
const WED = '2026-09-09';

describe('weeklySegmentsOf', () => {
  describe('within a single UTC day', () => {
    it('returns one segment for an ordinary session', () => {
      expect(weeklySegmentsOf(eventOver(`${MON}T17:00:00Z`, `${MON}T19:00:00Z`))).toEqual([
        { dayOfWeek: 1, startMinute: 1020, endMinute: 1140 },
      ]);
    });

    it('counts from midnight when the event starts at midnight', () => {
      expect(weeklySegmentsOf(eventOver(`${MON}T00:00:00Z`, `${MON}T06:00:00Z`))).toEqual([
        { dayOfWeek: 1, startMinute: 0, endMinute: 360 },
      ]);
    });

    it('rounds a sub-minute event up to a whole covered minute', () => {
      // Ceil on the end, so a partial minute is covered rather than trimmed to
      // an empty window the availability check could never satisfy.
      expect(weeklySegmentsOf(eventOver(`${MON}T10:00:15Z`, `${MON}T10:00:45Z`))).toEqual([
        { dayOfWeek: 1, startMinute: 600, endMinute: 601 },
      ]);
    });
  });

  describe('at the midnight boundary', () => {
    it('ends a session that finishes at midnight on the day it started', () => {
      // The case that used to be unassignable: 1440 is the exclusive end of
      // Monday, not minute 0 of Tuesday, so this stays one segment.
      expect(weeklySegmentsOf(eventOver(`${MON}T22:00:00Z`, `${TUE}T00:00:00Z`))).toEqual([
        { dayOfWeek: 1, startMinute: 1320, endMinute: MINUTES_PER_DAY },
      ]);
    });

    it('splits a session that runs into the next day', () => {
      expect(weeklySegmentsOf(eventOver(`${MON}T22:00:00Z`, `${TUE}T02:00:00Z`))).toEqual([
        { dayOfWeek: 1, startMinute: 1320, endMinute: MINUTES_PER_DAY },
        { dayOfWeek: 2, startMinute: 0, endMinute: 120 },
      ]);
    });

    it('splits a one-minute session that straddles midnight', () => {
      expect(weeklySegmentsOf(eventOver(`${MON}T23:59:30Z`, `${TUE}T00:00:30Z`))).toEqual([
        { dayOfWeek: 1, startMinute: 1439, endMinute: MINUTES_PER_DAY },
        { dayOfWeek: 2, startMinute: 0, endMinute: 1 },
      ]);
    });

    it('keeps an exactly-24-hour session to the single day it fills', () => {
      expect(weeklySegmentsOf(eventOver(`${MON}T00:00:00Z`, `${TUE}T00:00:00Z`))).toEqual([
        { dayOfWeek: 1, startMinute: 0, endMinute: MINUTES_PER_DAY },
      ]);
    });

    it('wraps the weekday number across a Saturday-to-Sunday boundary', () => {
      // 2026-09-12 is a Saturday: day 6 must be followed by day 0, not day 7.
      expect(weeklySegmentsOf(eventOver('2026-09-12T23:00:00Z', '2026-09-13T01:00:00Z'))).toEqual([
        { dayOfWeek: 6, startMinute: 1380, endMinute: MINUTES_PER_DAY },
        { dayOfWeek: 0, startMinute: 0, endMinute: 60 },
      ]);
    });
  });

  describe('spanning more than two days', () => {
    // EventsService.create caps events at 24h, so this is unreachable through
    // the API. Asserted anyway: the cap is a separate decision, and the
    // projection must not silently drop days if it is ever relaxed.
    it('emits a full-day segment for each whole day in between', () => {
      expect(weeklySegmentsOf(eventOver(`${MON}T10:00:00Z`, `${WED}T12:00:00Z`))).toEqual([
        { dayOfWeek: 1, startMinute: 600, endMinute: MINUTES_PER_DAY },
        { dayOfWeek: 2, startMinute: 0, endMinute: MINUTES_PER_DAY },
        { dayOfWeek: 3, startMinute: 0, endMinute: 720 },
      ]);
    });
  });

  describe('degenerate intervals', () => {
    it('returns nothing when the interval is empty', () => {
      expect(weeklySegmentsOf(eventOver(`${MON}T10:00:00Z`, `${MON}T10:00:00Z`))).toEqual([]);
    });

    it('returns nothing when the end precedes the start', () => {
      // EventsService.create rejects this first; the function must still not
      // loop forever or emit an inverted window.
      expect(weeklySegmentsOf(eventOver(`${MON}T10:00:00Z`, `${MON}T09:00:00Z`))).toEqual([]);
    });
  });

  describe('invariants every segment must satisfy', () => {
    const intervals: [string, string][] = [
      [`${MON}T17:00:00Z`, `${MON}T19:00:00Z`],
      [`${MON}T22:00:00Z`, `${TUE}T00:00:00Z`],
      [`${MON}T22:00:00Z`, `${TUE}T02:00:00Z`],
      [`${MON}T23:59:30Z`, `${TUE}T00:00:30Z`],
      [`${MON}T00:00:00Z`, `${TUE}T00:00:00Z`],
      [`${MON}T10:00:00Z`, `${WED}T12:00:00Z`],
      [`${MON}T10:00:15Z`, `${MON}T10:00:45Z`],
      ['2026-09-12T23:00:00Z', '2026-09-13T01:00:00Z'],
    ];

    it.each(intervals)('%s -> %s produces only usable windows', (startsAt, endsAt) => {
      const segments = weeklySegmentsOf(eventOver(startsAt, endsAt));
      expect(segments.length).toBeGreaterThan(0);
      for (const segment of segments) {
        // An inverted or empty window is one no availability slot can satisfy,
        // and an endMinute above 1440 is rejected by the range CHECK.
        expect(segment.startMinute).toBeGreaterThanOrEqual(0);
        expect(segment.endMinute).toBeGreaterThan(segment.startMinute);
        expect(segment.endMinute).toBeLessThanOrEqual(MINUTES_PER_DAY);
        expect(segment.dayOfWeek).toBeGreaterThanOrEqual(0);
        expect(segment.dayOfWeek).toBeLessThanOrEqual(6);
      }
    });

    it.each(intervals)('%s -> %s covers the interval without gaps', (startsAt, endsAt) => {
      const segments = weeklySegmentsOf(eventOver(startsAt, endsAt));
      const covered = segments.reduce((sum, s) => sum + (s.endMinute - s.startMinute), 0);
      const spanMinutes = Math.ceil(
        (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000,
      );
      // Ceil on each segment end can round up at most once per segment.
      expect(covered).toBeGreaterThanOrEqual(spanMinutes);
      expect(covered).toBeLessThanOrEqual(spanMinutes + segments.length);
    });
  });
});
