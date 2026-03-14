/**
 * useAutoResize – auto-expands a textarea as the user types.
 * Pass the ref of the textarea element.
 */

import { useEffect } from 'react';

export function useAutoResize(ref) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function resize() {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }

    el.addEventListener('input', resize);
    return () => el.removeEventListener('input', resize);
  }, [ref]);
}
