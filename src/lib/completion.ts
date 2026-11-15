/**
 * Completing a word from a list as it is typed: which entries what was
 * typed leaves, best first, and which letters of each matched. It knows
 * nothing of what starts the word or what the entries are; the slash
 * commands use it, and anything else typed after a key of its own can.
 */

/** The letters of a name that matched, each run by where it starts and
    where it ends. */
export type Marks = [number, number][];

export interface Match<T> {
  item: T;
  marks: Marks;
}

/** A name in pieces, the matched ones marked, for drawing. */
export interface Piece {
  text: string;
  hit: boolean;
}

/** Where a word begins in a name: at its first letter, and after a dash,
    an underscore, a colon, a dot, a slash or a space. */
export function wordStarts(name: string): number[] {
  const starts = [0];
  for (let at = 1; at < name.length; at++) if (/[-_:./\s]/.test(name[at - 1])) starts.push(at);
  return starts;
}

/**
 * The entries a query leaves, best first: those whose name begins with it,
 * then those with a later word that does, each in the owner's `order` and
 * then by name. Case is ignored. An empty query leaves every entry,
 * unmarked.
 */
export function rank<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  query: string,
  order: (a: T, b: T) => number = () => 0,
): Match<T>[] {
  const wanted = query.toLowerCase();
  const tiers: { item: T; name: string; tier: number; marks: Marks }[] = [];
  for (const item of items) {
    const name = nameOf(item);
    const lower = name.toLowerCase();
    if (wanted === "") {
      tiers.push({ item, name, tier: 0, marks: [] });
      continue;
    }
    if (lower.startsWith(wanted)) {
      tiers.push({ item, name, tier: 0, marks: [[0, wanted.length]] });
      continue;
    }
    const start = wordStarts(lower).find((at) => at > 0 && lower.startsWith(wanted, at));
    if (start !== undefined) tiers.push({ item, name, tier: 1, marks: [[start, start + wanted.length]] });
  }
  tiers.sort((a, b) => a.tier - b.tier || order(a.item, b.item) || compare(a.name, b.name));
  return tiers.map(({ item, marks }) => ({ item, marks }));
}

function compare(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A name cut where its marks begin and end. */
export function pieces(name: string, marks: Marks): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const [from, to] of marks) {
    const start = Math.max(0, from);
    const end = Math.min(name.length, to);
    if (end <= start || start < at) continue;
    if (start > at) out.push({ text: name.slice(at, start), hit: false });
    out.push({ text: name.slice(start, end), hit: true });
    at = end;
  }
  if (at < name.length) out.push({ text: name.slice(at), hit: false });
  return out;
}
