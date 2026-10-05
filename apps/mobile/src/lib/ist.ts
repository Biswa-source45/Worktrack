// Server times are UTC ISO strings; people read them in IST.
const day = { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' } as const;
const date = new Intl.DateTimeFormat('en-IN', day);
const dateTime = new Intl.DateTimeFormat('en-IN', {
  ...day,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** "4 Oct 2026, 2:42 pm" */
export const formatIst = (iso: string) => dateTime.format(new Date(iso));

/** "4 Oct 2026" */
export const formatIstDate = (iso: string) => date.format(new Date(iso));

const weekday = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const isoDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
const DAY_MS = 86_400_000;

/** "Mon, 5 Oct" */
export const formatIstDay = (iso: string) => weekday.format(new Date(iso));

/** The IST calendar day `offset` days from today, as "2026-10-04". */
export const istDay = (offset = 0) => isoDay.format(new Date(Date.now() + offset * DAY_MS));
