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
