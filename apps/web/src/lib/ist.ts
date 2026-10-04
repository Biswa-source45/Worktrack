// Server times are UTC ISO strings; people read them in IST.
const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  dateStyle: 'medium',
  timeStyle: 'short',
});
const isoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });

export const formatIst = (iso: string) => dateTime.format(new Date(iso));

/** Today's date in IST as YYYY-MM-DD, for date inputs. */
export const todayIst = () => isoDate.format(new Date());

const day = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', dateStyle: 'medium' });

/** A calendar date (YYYY-MM-DD) as people read it; it has no time zone of its own. */
export const formatDate = (date: string) => day.format(new Date(`${date}T00:00:00Z`));

/** Weekday of a calendar date as the API counts it: 0 = Monday .. 6 = Sunday. */
export const weekdayOf = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
