type Props = { ratio: string; size?: number };

// Small rectangle icon whose proportions match the requested aspect ratio.
// Used in the Higgsfield-style aspect-ratio dropdown.
export function RatioIcon({ ratio, size = 18 }: Props) {
  if (ratio === "auto") {
    return (
      <span
        className="inline-flex items-center justify-center text-pf-muted"
        style={{ width: size, height: size, fontSize: size * 0.55 }}
      >
        A
      </span>
    );
  }
  const [w, h] = ratio.split(":").map(Number);
  const max = size - 4; // padding inside box
  const rw = w >= h ? max : (w / h) * max;
  const rh = h >= w ? max : (h / w) * max;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <rect
        x={(size - rw) / 2}
        y={(size - rh) / 2}
        width={rw}
        height={rh}
        stroke="currentColor"
        strokeWidth={1.5}
        fill="none"
        rx={2}
      />
    </svg>
  );
}
