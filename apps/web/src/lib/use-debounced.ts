import { useEffect, useState } from 'react';

/** The value, but only after it has stopped changing for `ms`: keeps a search box from asking per key. */
export function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
