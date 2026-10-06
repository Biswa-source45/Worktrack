import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';

/** Calls `refetch` each time the screen comes back into view (not for the first showing). */
export function useRefetchOnFocus(refetch: () => unknown) {
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      // The query's own fetch on mount covers the first showing; a second one would cancel it.
      if (first.current) {
        first.current = false;
        return;
      }
      void refetch();
    }, [refetch]),
  );
}
