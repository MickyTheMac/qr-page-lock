/**
 * "Do this document's details add up?"
 *
 * Passports, ID cards and UK driving licences have rules built into them that a careless forger, or someone editing a
 * picture, tends to get wrong:
 *
 * - Machine lines (passports, ID cards): check numbers worked out from the document number, date of birth, expiry date
 *   and the lines as a whole; fixed places for letters and numbers.
 * - UK driving licence number: built from the surname, date of birth and initials printed on the same card.
 * - Dates: nobody is born in the future, and a document does not expire before its holder was born.
 *
 * Passing proves nothing about the document being genuine: a forger who knows the rules passes. It cannot see holograms
 * or security printing. A misread character (glare, blur) can also make a genuine document fail, so the page asks for a
 * retake first. Runs on the device only.
 */
import { ReadResult, checkDigit, toDigits } from "./read";

export interface FormatCheck {
  method: "format rules v1";
  result: "adds-up" | "does-not-add-up" | "not-checked";
  /** Plain sentences, e.g. "The passport's check numbers all match." */
  passed: string[];
  /** Plain sentences, e.g. "The licence number does not match the date of birth printed on the card." */
  problems: string[];
  /** The expiry date has passed. Not a sign of a fake, but worth knowing. */
  expired: boolean;
  /** How many pictures in a row did not add up (1 on the first, 2 after one retake, ...). 0 when it adds up. */
  attempts: number;
}

/** Text readers often swap these for the letters they look like, so they are not held against a letter field. */
const toLetters = (s: string) => s.replace(/[015826]/g, (c) => ({ "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G" })[c]!);
const LETTERS = { test: (s: string) => /^[A-Z<]+$/.test(toLetters(s)) };
const DIGITS = /^[0-9]+$/;

const today = () => new Date().toISOString().slice(0, 10);

function dateProblems(
  born: string,
  expires: string,
  issued: string | undefined,
  what: string,
  problems: string[],
  passed: string[],
) {
  const now = today();
  let ok = 0;
  if (born) {
    if (born > now) problems.push("The date of birth is in the future.");
    else if (Number(now.slice(0, 4)) - Number(born.slice(0, 4)) > 120)
      problems.push("The date of birth is more than 120 years ago.");
    else ok++;
  }
  if (born && expires) {
    if (expires <= born)
      problems.push(`The ${what} expires before its holder was born.`);
    else ok++;
  }
  if (issued) {
    if (expires && issued >= expires)
      problems.push(`The ${what} was issued after it expires.`);
    else if (born && issued < born)
      problems.push(`The ${what} was issued before its holder was born.`);
    else if (issued > now)
      problems.push(`The ${what} was issued in the future.`);
    else ok++;
  }
  if (ok) passed.push("The dates make sense together.");
}

/** ICAO 9303 machine lines: check numbers and where letters and numbers must be. */
function machineLines(
  mrz: NonNullable<NonNullable<ReadResult["raw"]>["mrz"]>,
  what: string,
  problems: string[],
  passed: string[],
) {
  const cd = (
    field: string,
    digit: string,
    label: string,
    fillerOk = false,
  ) => {
    const d = toDigits(digit);
    if (fillerOk && digit === "<" && /^<*$/.test(field)) return true;
    if (d !== checkDigit(field)) {
      problems.push(
        `The check number for the ${label} in the machine lines at the bottom does not match.`,
      );
      return false;
    }
    return true;
  };
  const before = problems.length;
  if (mrz.format === "TD3") {
    const [l1, l2] = mrz.lines;
    if (l1[0] !== "P")
      problems.push(
        "The machine lines do not start the way a passport's do (P).",
      );
    if (!LETTERS.test(l1.slice(2, 5)) || !LETTERS.test(l2.slice(10, 13)))
      problems.push(
        "The country codes in the machine lines have numbers where letters belong.",
      );
    if (/[0-9]/.test(l1.slice(5)))
      problems.push("The name in the machine lines has numbers in it.");
    const born = toDigits(l2.slice(13, 19));
    const exp = toDigits(l2.slice(21, 27));
    if (!DIGITS.test(born) || !DIGITS.test(exp))
      problems.push(
        "The dates in the machine lines have letters where numbers belong.",
      );
    if (!/[MFX<]/.test(l2[20]))
      problems.push("The sex in the machine lines is not M, F or <.");
    const okNum = cd(l2.slice(0, 9), l2[9], "passport number");
    const okBorn = cd(born, l2[19], "date of birth");
    const okExp = cd(exp, l2[27], "expiry date");
    const okOpt = cd(l2.slice(28, 42), l2[42], "personal number", true);
    // The final check number covers everything above, so a change anywhere shows here.
    if (okNum && okBorn && okExp && okOpt) {
      const composite =
        l2.slice(0, 10) + born + l2[19] + exp + l2[27] + l2.slice(28, 43);
      cd(composite, l2[43], "whole line");
    }
  } else {
    const [l1, l2, l3] = mrz.lines;
    if (!/^[IAC]/.test(l1))
      problems.push(
        "The machine lines do not start the way an ID card's do (I, A or C).",
      );
    if (!LETTERS.test(l1.slice(2, 5)) || !LETTERS.test(l2.slice(15, 18)))
      problems.push(
        "The country codes in the machine lines have numbers where letters belong.",
      );
    if (/[0-9]/.test(l3))
      problems.push("The name in the machine lines has numbers in it.");
    const born = toDigits(l2.slice(0, 6));
    const exp = toDigits(l2.slice(8, 14));
    if (!DIGITS.test(born) || !DIGITS.test(exp))
      problems.push(
        "The dates in the machine lines have letters where numbers belong.",
      );
    if (!/[MFX<]/.test(l2[7]))
      problems.push("The sex in the machine lines is not M, F or <.");
    const okNum = cd(l1.slice(5, 14), l1[14], "card number");
    const okBorn = cd(born, l2[6], "date of birth");
    const okExp = cd(exp, l2[14], "expiry date");
    if (okNum && okBorn && okExp) {
      const composite =
        l1.slice(5, 30) + born + l2[6] + exp + l2[14] + l2.slice(18, 29);
      cd(composite, l2[29], "whole card");
    }
  }
  if (problems.length === before)
    passed.push(
      `The ${what}'s check numbers all match, and letters and numbers are where they belong.`,
    );
}

/** The first five letters of the surname as DVLA writes them: letters only, MAC becomes MC, padded with 9. */
export function ukSurnameCode(surname: string): string {
  let s = surname.toUpperCase().replace(/[^A-Z]/g, "");
  if (s.startsWith("MAC")) s = "MC" + s.slice(3);
  return (s + "99999").slice(0, 5);
}

/** A UK driving licence number against the surname, date of birth and first names printed on the card. */
function ukLicence(
  number: string,
  surname: string,
  given: string,
  born: string,
  problems: string[],
  passed: string[],
) {
  const before = problems.length;
  const month = Number(number.slice(6, 8));
  const day = Number(number.slice(8, 10));
  if (
    !((month >= 1 && month <= 12) || (month >= 51 && month <= 62)) ||
    day < 1 ||
    day > 31
  )
    problems.push("The licence number does not hold a real date of birth.");
  if (surname && number.slice(0, 5) !== ukSurnameCode(surname))
    problems.push(
      "The licence number does not match the surname printed on the card.",
    );
  if (born) {
    const want = born[2] + born.slice(5, 7) + born.slice(8, 10) + born[3];
    const got =
      number[5] +
      String(month > 50 ? month - 50 : month).padStart(2, "0") +
      number.slice(8, 10) +
      number[10];
    if (want !== got)
      problems.push(
        "The licence number does not match the date of birth printed on the card.",
      );
  }
  const names = given.split(/\s+/).filter(Boolean);
  if (names.length) {
    const want = (names[0][0] + (names[1]?.[0] ?? "9")).toUpperCase();
    if (number.slice(11, 13) !== want)
      problems.push(
        "The licence number does not match the initials of the first names printed on the card.",
      );
  }
  if (problems.length === before && (surname || born || names.length))
    passed.push(
      "The licence number matches the name and date of birth printed on the card.",
    );
}

const UK = /^[A-Z9]{5}[0-9]{6}[A-Z9]{2}[0-9][A-Z]{2}$/;

/**
 * Checks what was read off the document (before the person corrected anything). `attempts` is how many pictures in a
 * row before this one did not add up.
 */
export function checkFormat(
  kind: string,
  r: ReadResult | null,
  previousFailures = 0,
): FormatCheck {
  const base = { method: "format rules v1" as const };
  const problems: string[] = [];
  const passed: string[] = [];
  const what =
    kind === "Driving licence"
      ? "licence"
      : kind === "ID card"
        ? "ID card"
        : "passport";
  if (!r?.source)
    return {
      ...base,
      result: "not-checked",
      passed,
      problems,
      expired: false,
      attempts: 0,
    };
  const f = r.fields;
  let structural = false;
  if (r.raw?.mrz) {
    machineLines(r.raw.mrz, what, problems, passed);
    structural = true;
  }
  if (kind === "Driving licence" && UK.test(f.number)) {
    ukLicence(
      f.number,
      r.raw?.surname ?? "",
      r.raw?.given ?? "",
      f.born,
      problems,
      passed,
    );
    structural = true;
  }
  dateProblems(f.born, f.expires, r.raw?.issued, what, problems, passed);
  const expired = !!f.expires && f.expires < today();
  const result = problems.length
    ? "does-not-add-up"
    : structural || passed.length
      ? "adds-up"
      : "not-checked";
  return {
    ...base,
    result,
    passed,
    problems,
    expired,
    attempts: result === "does-not-add-up" ? previousFailures + 1 : 0,
  };
}

/** One plain line for the person, e.g. "These details add up." */
export function formatMessage(c: FormatCheck, what: string): string {
  const w = what.toLowerCase();
  if (c.result === "adds-up")
    return `These details add up. ${c.passed.join(" ")}`;
  if (c.result === "not-checked")
    return `PageLock could not read enough of the ${w} to check its details.`;
  if (c.attempts >= 2)
    return `These details still do not add up after a retake, so PageLock cannot accept this ${w}. ${c.problems.join(" ")}`;
  return `These details do not add up. ${c.problems.join(" ")}`;
}
