export function Bar({ v, tone }: { v: number; tone?: 'g' | 'r' | 'a' }) {
  const t = tone ?? (v >= 70 ? 'g' : v >= 40 ? 'a' : 'r');
  return <span className={`bar ${t}`} title={v.toFixed(0)}><i style={{ width: `${Math.max(0, Math.min(100, v))}%` }} /></span>;
}
