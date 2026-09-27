// The one icon the interface uses alone: a stepping chevron, an 18px line drawing
// in the current colour (DESIGN.md, "Icons").

const ROTATE = { left: 180, right: 0, down: 90, up: -90 } as const;

export function Chevron({ dir, size = 18 }: { dir: keyof typeof ROTATE; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" style={{ transform: `rotate(${ROTATE[dir]}deg)` }}>
      <path d="M7 4.5 11.5 9 7 13.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
