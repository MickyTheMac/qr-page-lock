import { describe, expect, it } from "vitest";
import { checkFormat, formatMessage, readFields, ukSurnameCode } from "../src/lib/pagelock/photo";

const P1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
const P2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";
const licence = (num: string, born = "01.02.1990", given = "ALEX JORDAN", sur = "MORGAN") =>
  `DRIVING LICENCE\n1. ${sur}\n2. ${given}\n3. ${born} UNITED KINGDOM\n4a. 01.01.2020\n4b. 26.11.2036\n5. ${num} 01\n`;

describe("do the details add up?", () => {
  it("passes the ICAO specimen passport (all check numbers, including the whole line)", () => {
    const c = checkFormat("Passport", readFields("Passport", `${P1}\n${P2}`));
    expect(c.problems).toEqual([]);
    expect(c.result).toBe("adds-up");
    expect(c.expired).toBe(true); // the specimen expired in 2012
  });

  it("fails a passport whose date of birth was edited", () => {
    const edited = P2.replace("740812", "840812");
    const c = checkFormat("Passport", readFields("Passport", `${P1}\n${edited}`));
    expect(c.result).toBe("does-not-add-up");
    expect(c.problems.join(" ")).toMatch(/date of birth/);
    expect(c.attempts).toBe(1);
    expect(checkFormat("Passport", readFields("Passport", `${P1}\n${edited}`), 1).attempts).toBe(2);
  });

  it("catches a change the field check numbers miss, through the whole-line check number", () => {
    const edited = P2.replace("ZE184226B", "ZE184226C").replace("<<<<<10", "<<<<<20"); // personal number check fixed, final not
    const c = checkFormat("Passport", readFields("Passport", `${P1}\n${edited}`));
    expect(c.result).toBe("does-not-add-up");
  });

  it("passes the ICAO specimen ID card", () => {
    const t = "I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<";
    expect(checkFormat("ID card", readFields("ID card", t)).problems).toEqual([]);
  });

  it("matches a UK licence number with the printed name and date of birth", () => {
    const c = checkFormat("Driving licence", readFields("Driving licence", licence("MORGA902010AJ9XY")));
    expect(c.problems).toEqual([]);
    expect(c.result).toBe("adds-up");
    expect(formatMessage(c, "Driving licence")).toMatch(/add up/);
  });

  it("knows women's licence numbers add 5 to the month digit", () => {
    expect(checkFormat("Driving licence", readFields("Driving licence", licence("MORGA952010AJ9XY"))).result).toBe("adds-up");
  });

  it("fails a licence whose number does not match the date of birth, surname or initials", () => {
    const born = checkFormat("Driving licence", readFields("Driving licence", licence("MORGA901020AJ9XY")));
    expect(born.problems).toEqual(["The licence number does not match the date of birth printed on the card."]);
    const sur = checkFormat("Driving licence", readFields("Driving licence", licence("SMITH902010AJ9XY")));
    expect(sur.problems.join(" ")).toMatch(/surname/);
    const ini = checkFormat("Driving licence", readFields("Driving licence", licence("MORGA902010AB9XY")));
    expect(ini.problems.join(" ")).toMatch(/initials/);
  });

  it("writes surnames the DVLA way", () => {
    expect(ukSurnameCode("MacDonald")).toBe("MCDON");
    expect(ukSurnameCode("Li")).toBe("LI999");
    expect(ukSurnameCode("O'Brien")).toBe("OBRIE");
  });

  it("catches dates that make no sense", () => {
    const future = checkFormat("Driving licence", readFields("Driving licence", licence("MORGA902010AJ9XY", "01.02.2090")));
    expect(future.result).toBe("does-not-add-up");
    expect(future.problems.join(" ")).toMatch(/future/);
  });

  it("does not judge when nothing was read", () => {
    expect(checkFormat("Driving licence", readFields("Driving licence", "")).result).toBe("not-checked");
  });
});

describe("misreads that are not held against a document", () => {
  it("allows O read as 0 in a country code", () => {
    const c = checkFormat("Passport", readFields("Passport", `${P1.replace("UTO", "UT0")}\n${P2.replace("UTO", "UT0")}`));
    expect(c.problems).toEqual([]);
  });
});
