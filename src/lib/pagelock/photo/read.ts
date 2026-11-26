/**
 * Reads the main details off a licence, passport or ID card, from the words the device read in the picture, so the
 * person does not have to type them. Runs on the device; nothing is sent anywhere.
 *
 * - Passports and ID cards: the machine-readable lines at the bottom (P<GBR..., I<FRA...). These carry check digits,
 *   so a misread is usually caught.
 * - Driving licences: the numbered fields every UK and EU licence uses (1 surname, 2 first names, 3 date of birth,
 *   4b expiry, 5 licence number). No check digits, so less reliable.
 *
 * The person always sees what was read and can fix it before the picture is sealed.
 */

export interface ReadFields {
  /** Full name, first names then surname, e.g. "ALEX JORDAN MORGAN". */
  name: string;
  /** Document or licence number. */
  number: string;
  /** Dates as YYYY-MM-DD. */
  born: string;
  expires: string;
}

export interface ReadResult {
  fields: ReadFields;
  /** Where they came from. */
  source: "machine lines" | "printed fields" | null;
  /** Machine lines only: whether every check digit matched (true means very likely read correctly). */
  checkDigitsOk: boolean | null;
  /** What the format checks need (see consistency.ts). */
  raw?: {
    /** The machine lines as read, cleaned and fitted to length. */
    mrz?: { format: "TD3" | "TD1"; lines: string[] };
    /** Printed fields, as read. */
    surname?: string;
    given?: string;
    /** Licence field 4a, YYYY-MM-DD. */
    issued?: string;
  };
}

export const EMPTY_FIELDS: ReadFields = { name: "", number: "", born: "", expires: "" };

const NOTHING: ReadResult = { fields: { ...EMPTY_FIELDS }, source: null, checkDigitsOk: null };

// ------------------------------------------------------------------ machine-readable lines (ICAO 9303)

const DIGITS: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6", T: "7" };
export const toDigits = (s: string) => s.replace(/[OQDILZSBGT]/g, (c) => DIGITS[c]);

/** ICAO check digit: weights 7, 3, 1; < counts 0, A=10 ... Z=35. */
export function checkDigit(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const v = c === "<" ? 0 : c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : c >= "A" && c <= "Z" ? c.charCodeAt(0) - 55 : 0;
    sum += v * [7, 3, 1][i % 3];
  }
  return String(sum % 10);
}

/** Lines that look machine-readable, cleaned of what text readers usually get wrong (spaces, « for <). */
function mrzLines(text: string): string[] {
  return text
    .toUpperCase()
    .split(/\n/)
    .map((l) => l.replace(/[«‹]/g, "<").replace(/\s+/g, "").replace(/[^A-Z0-9<]/g, ""))
    .filter((l) => l.length >= 26 && (l.match(/</g)?.length ?? 0) >= 2);
}

/** Pads or trims to an exact length (readers sometimes drop or add a trailing <). */
const fit = (l: string, n: number) => (l.length >= n ? l.slice(0, n) : l + "<".repeat(n - l.length));

/** YYMMDD to YYYY-MM-DD. Birth dates are in the past; expiry dates are this century. */
function mrzDate(s: string, kind: "born" | "expires"): string {
  const d = toDigits(s);
  if (!/^\d{6}$/.test(d)) return "";
  const yy = Number(d.slice(0, 2));
  const now = new Date().getUTCFullYear() % 100;
  const year = kind === "expires" ? 2000 + yy : yy > now ? 1900 + yy : 2000 + yy;
  return validDate(year, Number(d.slice(2, 4)), Number(d.slice(4, 6)));
}

function validDate(y: number, m: number, d: number): string {
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "MORGAN<<ALEX<JORDAN<<<" to "ALEX JORDAN MORGAN". */
function mrzName(s: string): string {
  const parts = s.replace(/[0-9]/g, "<").split("<<");
  const words = (x: string) => x.replace(/<+/g, " ").trim();
  return [words(parts.slice(1).join("<")), words(parts[0])].filter(Boolean).join(" ").replace(/\s+/g, " ");
}

function passportLines(lines: string[]): ReadResult | null {
  const i = lines.findIndex((l) => /^P[A-Z<]/.test(l) && l.length >= 36);
  if (i < 0 || i + 1 >= lines.length) return null;
  const l1 = fit(lines[i], 44);
  const l2 = fit(lines[i + 1], 44);
  const number = l2.slice(0, 9);
  const bornRaw = toDigits(l2.slice(13, 19));
  const expRaw = toDigits(l2.slice(21, 27));
  const ok =
    toDigits(l2[9]) === checkDigit(number) && toDigits(l2[19]) === checkDigit(bornRaw) && toDigits(l2[27]) === checkDigit(expRaw);
  return {
    fields: { name: mrzName(l1.slice(5)), number: number.replace(/<+$/g, "").replace(/</g, ""), born: mrzDate(bornRaw, "born"), expires: mrzDate(expRaw, "expires") },
    source: "machine lines",
    checkDigitsOk: ok,
    raw: { mrz: { format: "TD3", lines: [l1, l2] } },
  };
}

function idCardLines(lines: string[]): ReadResult | null {
  const i = lines.findIndex((l) => /^[IAC][A-Z<]/.test(l) && l.length >= 26 && l.length <= 34);
  if (i < 0 || i + 2 >= lines.length) return null;
  const l1 = fit(lines[i], 30);
  const l2 = fit(lines[i + 1], 30);
  const l3 = fit(lines[i + 2], 30);
  const number = l1.slice(5, 14);
  const bornRaw = toDigits(l2.slice(0, 6));
  const expRaw = toDigits(l2.slice(8, 14));
  const ok = toDigits(l1[14]) === checkDigit(number) && toDigits(l2[6]) === checkDigit(bornRaw) && toDigits(l2[14]) === checkDigit(expRaw);
  return {
    fields: { name: mrzName(l3), number: number.replace(/</g, ""), born: mrzDate(bornRaw, "born"), expires: mrzDate(expRaw, "expires") },
    source: "machine lines",
    checkDigitsOk: ok,
    raw: { mrz: { format: "TD1", lines: [l1, l2, l3] } },
  };
}

// ------------------------------------------------------------------ printed, numbered fields (driving licences)

/** dd.mm.yyyy (or with / or -) to YYYY-MM-DD. */
function printedDate(s: string): string {
  const m = s.match(/(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})/);
  if (!m) return "";
  let y = Number(m[3]);
  if (m[3].length === 2) y += y > new Date().getUTCFullYear() % 100 ? 1900 : 2000;
  return validDate(y, Number(m[2]), Number(m[1]));
}

/** UK licence number: 5 letters of surname (padded with 9), 6 digits, 2 initials (padded with 9), 1 digit, 2 letters. */
const UK_NUMBER = /\b([A-Z9]{5}[0-9OIL]{6}[A-Z9]{2}[0-9OIL][A-Z]{2})\b/;

function licenceFields(text: string): ReadResult | null {
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // A field label like "1." "2." "4b." at the start of a line. The value is on the same line, or the next line when
  // the same line only holds the label's name ("1. Surname").
  const field = (label: RegExp): string => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(label);
      if (!m) continue;
      const rest = lines[i].slice(m[0].length).trim();
      const isCaption = /^[A-Za-z][a-z]/.test(rest) && rest !== rest.toUpperCase();
      return (isCaption || !rest ? (lines[i + 1] ?? "") : rest).trim();
    }
    return "";
  };
  const sur = field(/^1\s*[.,]\s*/);
  const given = field(/^2\s*[.,]\s*/);
  const born = printedDate(field(/^3\s*[.,]\s*/));
  const expires = printedDate(field(/^4\s*[bB8]\s*[.,]?\s*/));
  const issued = printedDate(field(/^4\s*[aA]\s*[.,]?\s*/));
  const five = field(/^5\s*[.,]\s*/).toUpperCase().replace(/\s+/g, " ");
  const upper = text.toUpperCase();
  const uk = upper.replace(/\s+/g, " ").match(UK_NUMBER)?.[1];
  const number = uk ? uk.slice(0, 5) + toDigits(uk.slice(5, 11)) + uk.slice(11, 13) + toDigits(uk[13]) + uk.slice(14) : (five.split(" ")[0] ?? "").replace(/[^A-Z0-9]/g, "");
  const nameOnly = (s: string) => (/^[A-Za-zÀ-ÿ' -]+$/.test(s) ? s.toUpperCase().replace(/\s+/g, " ").trim() : "");
  const name = [nameOnly(given), nameOnly(sur)].filter(Boolean).join(" ");
  if (!name && !number && !born && !expires) return null;
  return {
    fields: { name, number, born, expires },
    source: "printed fields",
    checkDigitsOk: null,
    raw: { surname: nameOnly(sur), given: nameOnly(given), ...(issued ? { issued } : {}) },
  };
}

// ------------------------------------------------------------------

export function readFields(kind: string, text: string): ReadResult {
  if (kind === "Passport" || kind === "ID card") {
    const lines = mrzLines(text);
    const r = kind === "Passport" ? (passportLines(lines) ?? idCardLines(lines)) : (idCardLines(lines) ?? passportLines(lines));
    if (r) return r;
    return licenceFields(text) ?? NOTHING;
  }
  if (kind === "Driving licence") return licenceFields(text) ?? NOTHING;
  return NOTHING;
}

/** Which of the fields were found, e.g. ["name", "number"]. */
export function foundFields(r: ReadResult): (keyof ReadFields)[] {
  return (Object.keys(r.fields) as (keyof ReadFields)[]).filter((k) => r.fields[k]);
}
