import { describe, expect, it } from "vitest";
import { checkDigit, readFields } from "../src/lib/pagelock/photo/read";

describe("reading details off a document", () => {
  it("works out ICAO check digits", () => {
    expect(checkDigit("L898902C3")).toBe("6");
    expect(checkDigit("740812")).toBe("2");
    expect(checkDigit("120415")).toBe("9");
  });

  it("reads a passport's machine lines, even with spaces and « from the reader", () => {
    const text = "PASSPORT\nUtopia\nP<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10\n";
    const r = readFields("Passport", text);
    expect(r.source).toBe("machine lines");
    expect(r.checkDigitsOk).toBe(true);
    expect(r.fields).toEqual({ name: "ANNA MARIA ERIKSSON", number: "L898902C3", born: "1974-08-12", expires: "2012-04-15" });
    const messy = "P<UTOERIKSSON «ANNA<MARIA «<<<<<<<<<<<<<<<<<\nL898902C36UTO74O8122F1204159ZE184226B<<<<< 10";
    const m = readFields("Passport", messy);
    expect(m.fields.born).toBe("1974-08-12");
    expect(m.checkDigitsOk).toBe(true);
  });

  it("notices a misread through the check digits", () => {
    const r = readFields("Passport", "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C46UTO7408122F1204159ZE184226B<<<<<10");
    expect(r.checkDigitsOk).toBe(false);
  });

  it("reads an ID card's three machine lines", () => {
    const text = "IDENTITY CARD\nI<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<";
    const r = readFields("ID card", text);
    expect(r.checkDigitsOk).toBe(true);
    expect(r.fields).toEqual({ name: "ANNA MARIA ERIKSSON", number: "D23145890", born: "1974-08-12", expires: "2012-04-15" });
  });

  it("reads a UK-style licence with values on the same line", () => {
    const text = "DRIVING LICENCE\n1. MORGAN\n2. ALEX JORDAN\n3. 01.02.1990 UNITED KINGDOM\n4a. 01.01.2020 4c. DVLA\n4b. 26.11.2036\n5. MORGA901020AJ9XY 01\n";
    const r = readFields("Driving licence", text);
    expect(r.source).toBe("printed fields");
    expect(r.fields).toEqual({ name: "ALEX JORDAN MORGAN", number: "MORGA901020AJ9XY", born: "1990-02-01", expires: "2036-11-26" });
  });

  it("reads a licence with captions above the values", () => {
    const text = "DRIVING LICENCE SPECIMEN\n1. Surname\nMORGAN\n2. Given names\nALEX JORDAN\n3. Date of birth\n01.02.1990\n5. Licence number\nMORGA9O1020AJ9XY\n4b. Expires\n26.11.2036";
    const r = readFields("Driving licence", text);
    expect(r.fields).toEqual({ name: "ALEX JORDAN MORGAN", number: "MORGA901020AJ9XY", born: "1990-02-01", expires: "2036-11-26" });
  });

  it("finds nothing in a selfie", () => {
    expect(readFields("Driving licence", "").source).toBeNull();
    expect(readFields("Passport", "a b c").fields.name).toBe("");
  });
});
