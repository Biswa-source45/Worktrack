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

const clock = {
  timeZone: 'Asia/Kolkata',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
} as const;
const time = new Intl.DateTimeFormat('en-IN', clock);
const timeWithSeconds = new Intl.DateTimeFormat('en-IN', { ...clock, second: '2-digit' });

/** "2:42 pm" */
export const formatIstTime = (iso: string) => time.format(new Date(iso));

/** "2:42:07 pm", for a clock that ticks. */
export const formatIstClock = (ms: number) => timeWithSeconds.format(new Date(ms));

/**
 * How far the server's clock is ahead of this phone's, from one answer. Add it to the phone's
 * time to show the server's time (server time is the only truth; the phone's clock may be wrong).
 */
export const clockOffset = (serverIso: string, receivedAt: number) =>
  Date.parse(serverIso) - receivedAt;
