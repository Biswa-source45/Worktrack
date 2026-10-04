import { useId, type ComponentProps } from 'react';

// Original decoration shapes (docs/DESIGN.md section 8). They take their colour from the
// parent's text colour, are hidden from assistive technology and never sit behind tables or forms.
type Props = Omit<ComponentProps<'svg'>, 'children'>;

export function Blob(props: Props) {
  return (
    <svg aria-hidden="true" viewBox="0 0 200 200" fill="currentColor" {...props}>
      <path d="M100 12c34 0 72 22 80 58s-10 78-44 98-82 22-108-6S-2 92 12 56 66 12 100 12Z" />
    </svg>
  );
}

/** A filled band whose top edge is one soft wave: the curved panel edge. */
export function CurvedEdge(props: Props) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1440 120"
      preserveAspectRatio="none"
      fill="currentColor"
      {...props}
    >
      <path d="M0 120V64C240 8 480 0 720 28s480 52 720 4v88Z" />
    </svg>
  );
}

export function HalfCircles(props: Props) {
  return (
    <svg aria-hidden="true" viewBox="0 0 120 60" fill="currentColor" {...props}>
      <path opacity="0.35" d="M0 60a60 60 0 0 1 120 0Z" />
      <path opacity="0.55" d="M20 60a40 40 0 0 1 80 0Z" />
      <path d="M40 60a20 20 0 0 1 40 0Z" />
    </svg>
  );
}

export function DotPattern(props: Props) {
  const id = useId();
  return (
    <svg aria-hidden="true" fill="currentColor" {...props}>
      <pattern id={id} width="20" height="20" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1" />
      </pattern>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
