// Server times are UTC ISO strings; people read them in IST.
const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  dateStyle: 'medium',
  timeStyle: 'short',
});
const clock = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
});
const isoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });

export const formatIst = (iso: string) => dateTime.format(new Date(iso));

/** The time of day only, in IST, for tables that already show the date elsewhere. */
export const formatClock = (iso: string) => clock.format(new Date(iso));

// India has no daylight saving, so IST is always UTC+05:30.
const IST_OFFSET_MS = 330 * 60_000;

/** An instant as the value of a `datetime-local` input, read in IST (YYYY-MM-DDTHH:mm). */
export const toIstLocal = (iso: string) =>
  new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(0, 16);

/** The reverse: an IST `datetime-local` value as an ISO time with its zone, for the API. */
export const fromIstLocal = (local: string) => `${local}:00+05:30`;

/** Today's date in IST as YYYY-MM-DD, for date inputs. */
export const todayIst = () => isoDate.format(new Date());

const day = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', dateStyle: 'medium' });

/** A calendar date (YYYY-MM-DD) as people read it; it has no time zone of its own. */
export const formatDate = (date: string) => day.format(new Date(`${date}T00:00:00Z`));

/** Weekday of a calendar date as the API counts it: 0 = Monday .. 6 = Sunday. */
export const weekdayOf = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
