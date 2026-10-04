import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

/** A warning the admin must not miss (one-time passwords): danger tone, icon and text. */
export function AlertNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex gap-2 rounded-md border border-danger/40 bg-danger-subtle p-3 text-small text-danger"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
