/**
 * "Does this picture look like the document it is meant to be?"
 *
 * The browser reads the words in the picture (on the device, never sent anywhere) and this decides whether they are
 * the words that kind of document carries: "DRIVING LICENCE" on a licence, the machine-readable lines (P<GBR...) on a
 * passport, and so on. A selfie or a picture of a room has none of them.
 *
 * It is a sense check against mistakes, not a forgery check: a fake licence carries the same words.
 */

export type DocKind = "Driving licence" | "Passport" | "ID card" | "Document" | "Other";

export interface LooksCheck {
  method: "on-device text reading v1";
  /** What the person said it is. */
  expected: string;
  result: "recognised" | "not-recognised" | "skipped";
  /** If it looks like a different kind of document, which one. */
  looksLike: DocKind | null;
  /** Up to 5 short words or lines that were found, e.g. "DRIVING LICENCE". */
  found: string[];
}

function edits(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Uppercase words (letters only), with common OCR swaps undone. */
function words(text: string): string[] {
  return text
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Z0-9]+/)
    .map((w) => w.replace(/0/g, "O").replace(/1/g, "I").replace(/5/g, "S"))
    .filter((w) => /[A-Z]/.test(w));
}

function hasWord(ws: string[], target: string): string | null {
  const max = target.length >= 7 ? 2 : target.length >= 5 ? 1 : 0;
  return ws.find((w) => edits(w, target, max) <= max) ?? null;
}

/** Two words next to each other, each allowing small reading errors. */
function hasPair(ws: string[], a: string, b: string): string | null {
  for (let i = 0; i < ws.length - 1; i++) {
    if (hasWord([ws[i]], a) && hasWord([ws[i + 1]], b)) return `${a} ${b}`;
  }
  return null;
}

/** Machine-readable zone lines, like P<GBRSMITH<<JOHN<<<<. */
function mrz(text: string, first: RegExp): boolean {
  return text
    .toUpperCase()
    .replace(/[ \t«]/g, "<")
    .split(/\n/)
    .some((l) => first.test(l) && (l.match(/</g)?.length ?? 0) >= 5);
}

const MARKS: Record<Exclude<DocKind, "Document" | "Other">, (ws: string[], text: string) => string | null> = {
  "Driving licence": (ws) =>
    hasPair(ws, "DRIVING", "LICENCE") ??
    hasPair(ws, "DRIVING", "LICENSE") ??
    hasPair(ws, "DRIVER", "LICENSE") ??
    hasPair(ws, "PERMIS", "CONDUIRE") ??
    (hasWord(ws, "DVLA") ? "DVLA" : null) ??
    (hasWord(ws, "FUHRERSCHEIN") ? "FUHRERSCHEIN" : null) ??
    (hasWord(ws, "RIJBEWIJS") ? "RIJBEWIJS" : null) ??
    hasPair(ws, "PATENTE", "GUIDA") ??
    hasPair(ws, "PERMISO", "CONDUCCION") ??
    hasPair(ws, "PRAWO", "JAZDY"),
  Passport: (ws, text) =>
    (mrz(text, /^P[A-Z<][A-Z<]{3}/) ? "P< passport lines" : null) ??
    (hasWord(ws, "PASSPORT") ? "PASSPORT" : null) ??
    (hasWord(ws, "PASSEPORT") ? "PASSEPORT" : null) ??
    (hasWord(ws, "REISEPASS") ? "REISEPASS" : null) ??
    (hasWord(ws, "PASAPORTE") ? "PASAPORTE" : null),
  "ID card": (ws, text) =>
    (mrz(text, /^[IAC][A-Z<][A-Z<]{3}/) ? "ID card lines" : null) ??
    hasPair(ws, "IDENTITY", "CARD") ??
    hasPair(ws, "ID", "CARD") ??
    (hasWord(ws, "IDENTITY") ? "IDENTITY" : null) ??
    (hasWord(ws, "PERSONALAUSWEIS") ? "PERSONALAUSWEIS" : null) ??
    (hasWord(ws, "IDENTITE") ? "IDENTITE" : null) ??
    hasPair(ws, "RESIDENCE", "PERMIT"),
};

/** Enough readable words to count as "a document with writing on it". */
function hasWriting(ws: string[]): boolean {
  return ws.filter((w) => w.length >= 3 && /^[A-Z]+$/.test(w)).length >= 8;
}

export function judgeLooks(expected: string, text: string): LooksCheck {
  const base = { method: "on-device text reading v1" as const, expected };
  if (expected === "Other") return { ...base, result: "skipped", looksLike: null, found: [] };
  const ws = words(text);
  const marks = (Object.keys(MARKS) as (keyof typeof MARKS)[]).map((k) => [k, MARKS[k](ws, text)] as const);
  if (expected === "Document") {
    const ok = hasWriting(ws) || marks.some(([, m]) => m);
    return { ...base, result: ok ? "recognised" : "not-recognised", looksLike: null, found: ok ? ws.filter((w) => w.length >= 4).slice(0, 5) : [] };
  }
  const mine = marks.find(([k]) => k === expected)?.[1] ?? null;
  if (mine) return { ...base, result: "recognised", looksLike: expected as DocKind, found: [mine] };
  const other = marks.find(([k, m]) => k !== expected && m);
  if (other) return { ...base, result: "not-recognised", looksLike: other[0], found: [other[1]!] };
  return { ...base, result: "not-recognised", looksLike: hasWriting(ws) ? "Document" : null, found: [] };
}

/** One plain sentence for the person, e.g. "This doesn't look like a driving licence: it looks like a passport." */
export function looksMessage(c: LooksCheck): string {
  const what = c.expected.toLowerCase();
  if (c.result === "skipped") return "No document check was asked for.";
  if (c.result === "recognised")
    return c.expected === "Document" ? "It has writing on it, so it looks like a document." : `It looks like a ${what} (PageLock read "${c.found[0]}").`;
  if (c.looksLike && c.looksLike !== "Document") return `This doesn't look like a ${what}. It looks more like a ${c.looksLike.toLowerCase()}.`;
  if (c.looksLike === "Document") return `This doesn't look like a ${what}. PageLock can see writing, but none of the words a ${what} carries.`;
  return `Hang on: PageLock can't see a ${what} in this picture. It has none of the words a ${what} carries.`;
}
