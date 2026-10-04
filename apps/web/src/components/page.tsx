import type { ReactNode } from 'react';

/** One screen inside the shell: its content fades up 8px on arrival. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <section className="animate-in space-y-4 duration-250 ease-out fade-in slide-in-from-bottom-2">
      {children}
    </section>
  );
}

/** Title on the left, the page's controls on the right; wraps on narrow screens. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h1 className="mr-auto text-h1">{title}</h1>
      {children}
    </div>
  );
}
