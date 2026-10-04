import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * True while the system Reduce Motion setting is on: no transform animation, no pulsing.
 * Also true until the setting has been read, so nothing moves before the answer is known.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduced(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
