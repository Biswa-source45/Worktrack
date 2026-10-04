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
