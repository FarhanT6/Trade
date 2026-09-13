export function Sparkline({ points, color = '#5aa9ff' }: { points: Array<{ ts: number; priceUsd: number }>; color?: string }) {
  if (points.length < 2) return <div className="muted">no price history</div>;
  const w = 600;
  const h = 120;
  const ys = points.map((p) => p.priceUsd);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const x = (i: number) => (i / (points.length - 1)) * w;
  const y = (v: number) => h - 6 - ((v - lo) / Math.max(1e-12, hi - lo)) * (h - 12);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.priceUsd).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} />
      <text x={4} y={12} fill="#7d8899" fontSize={10}>{hi.toExponential(2)}</text>
      <text x={4} y={h - 2} fill="#7d8899" fontSize={10}>{lo.toExponential(2)}</text>
    </svg>
  );
}
