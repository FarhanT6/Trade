let counter = 0;
/** Monotonic, collision-free ids without a crypto dependency (fine for in-process use). */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000_000;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}
