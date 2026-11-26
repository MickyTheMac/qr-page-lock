/**
 * The encrypted vault: email-code login, locking on the device, sharing with the other signer, losing keys.
 * The key property tested throughout: the server's stored data never contains anything readable.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { makeSampleAgreement } from "./helpers";
import {
  MemoryStore,
  MemoryVaultStore,
  PageLockService,
  VaultClient,
  VaultIdentity,
  VaultService,
  VaultStore,
  deriveIdentity,
  inPageFetch,
  lockRootWithPasskey,
  newRoot,
  preparePdf,
  rootToWords,
  safetyCode,
  unlockRootWithPasskey,
  verifyPdf,
  wordsToRoot,
} from "../src/lib/pagelock";

const mail: { to: string; subject: string; text: string }[] = [];
let vaultStore: VaultStore;
let dumpStore: () => Promise<string>;
let service: PageLockService;

function client() {
  return new VaultClient("https://service.test", inPageFetch(service));
}

async function login(c: VaultClient, email: string) {
  const s = await c.startLogin(email);
  const code = mail.filter((m) => m.to === email.toLowerCase() && /login code/.test(m.subject)).pop()!.text.match(/\d{6}/)![0];
  return c.finishLogin(s.loginId, code);
}

async function setUp(email: string) {
  const c = client();
  await login(c, email);
  const root = newRoot();
  const me = await deriveIdentity(root);
  await c.setKey(me);
  return { c, root, me };
}

let sealed: Uint8Array;
let facts: { documentId: string; manifestDigest: string };

beforeAll(async () => {
  const url = process.env.PAGELOCK_TEST_DATABASE_URL;
  if (url) {
    // Against a real (throwaway) Postgres: wipe the vault tables, then dump every row as text.
    const { Client } = await import("pg");
    const db = new Client({ connectionString: url });
    await db.connect();
    const tables = ["pagelock_vault_members", "pagelock_vault_files", "pagelock_vault_docs", "pagelock_vault_sessions", "pagelock_vault_logins", "pagelock_vault_accounts", "pagelock_vault_secrets"];
    await db.query(`DROP TABLE IF EXISTS ${tables.join(", ")}`);
    const { PgVaultStore } = await import("../server/pg-vault-store");
    vaultStore = await PgVaultStore.connect(url);
    dumpStore = async () => {
      let out = "";
      for (const t of tables) {
        const r = await db.query(`SELECT * FROM ${t}`);
        out += JSON.stringify(r.rows.map((row) => Object.values(row).map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") : v))));
      }
      return out;
    };
  } else {
    const mem = new MemoryVaultStore();
    vaultStore = mem;
    dumpStore = async () => memoryDump(mem);
  }
  const mailer = { send: async (to: string, subject: string, text: string) => void mail.push({ to, subject, text }) };
  const vault = await VaultService.create({ store: vaultStore, mailer, siteUrl: "https://pagelock.test" });
  service = await PageLockService.create({ store: new MemoryStore(), mailer, vault });
  sealed = (await preparePdf(await makeSampleAgreement(2))).pdfBytes;
  const r = await verifyPdf(sealed);
  facts = { documentId: r.documentId!, manifestDigest: r.manifestDigest! };
});

/** Everything the server holds, as one string, to check nothing readable is in it. */
function serverDump(): Promise<string> {
  return dumpStore();
}

function memoryDump(store: MemoryVaultStore): string {
  const s = store as unknown as Record<string, Map<string, unknown>>;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(s).map(([k, v]) => [k, [...(v as Map<string, unknown>).entries()].map(([a, b]) => [a, b instanceof Uint8Array ? Buffer.from(b).toString("latin1") : b])]),
    ),
  );
}

describe("crypto", () => {
  it("24 recovery words give back exactly the same keys", async () => {
    const root = newRoot();
    const words = rootToWords(root);
    expect(words).toHaveLength(24);
    const again = wordsToRoot("  " + words.join("  ").toUpperCase() + "\n");
    expect(Buffer.from(again).equals(Buffer.from(root))).toBe(true);
    expect((await deriveIdentity(again)).keyFp).toBe((await deriveIdentity(root)).keyFp);
  });
  it("a wrong or misspelt word is caught", () => {
    const words = rootToWords(newRoot());
    expect(() => wordsToRoot(words.slice(0, 23).join(" "))).toThrow(/all 24/);
    expect(() => wordsToRoot([...words.slice(0, 23), "pagelockx"].join(" "))).toThrow(/not one of/);
    const swapped = [...words];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    if (swapped[0] !== words[0]) expect(() => wordsToRoot(swapped.join(" "))).toThrow();
  });
  it("padlocks are post-quantum hybrid (X-Wing) and the safety code is the same on both screens", async () => {
    const a = await deriveIdentity(newRoot());
    const b = await deriveIdentity(newRoot());
    expect(a.publicKey.length).toBe(1216);
    const code = await safetyCode(a.publicKey, b.publicKey);
    expect(code).toMatch(/^\d{4}( \d{4}){4}$/);
    expect(await safetyCode(b.publicKey, a.publicKey)).toBe(code);
    const c = await deriveIdentity(newRoot());
    expect(await safetyCode(a.publicKey, c.publicKey)).not.toBe(code);
  });
  it("a passkey's secret opens the root only for the right keys", async () => {
    const root = newRoot();
    const prf = new Uint8Array(32).fill(9);
    const boxed = await lockRootWithPasskey(root, prf, "aa");
    expect(Buffer.from(await unlockRootWithPasskey(boxed, prf, "aa")).equals(Buffer.from(root))).toBe(true);
    await expect(unlockRootWithPasskey(boxed, new Uint8Array(32).fill(8), "aa")).rejects.toThrow(/could not be unlocked/);
    await expect(unlockRootWithPasskey(boxed, prf, "bb")).rejects.toThrow(/could not be unlocked/);
  });
});

describe("login", () => {
  it("logs in with an email code; the server keeps no readable email address", async () => {
    const c = client();
    const r = await login(c, "Micky@Example.com");
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.account.keyFp).toBeNull();
    expect(await serverDump()).not.toMatch(/micky@example\.com/i);
  });
  it("a wrong code is refused, 5 wrong codes end the login, and a code works only once", async () => {
    const c = client();
    const s = await c.startLogin("wrong@example.com");
    for (let i = 0; i < 4; i++) await expect(c.finishLogin(s.loginId, "000000x")).rejects.toThrow(/not right/);
    await expect(c.finishLogin(s.loginId, "000000x")).rejects.toThrow(/Too many/);
    const code = mail.filter((m) => m.to === "wrong@example.com").pop()!.text.match(/\d{6}/)![0];
    await expect(c.finishLogin(s.loginId, code)).rejects.toThrow(/Too many/);

    const s2 = await c.startLogin("once@example.com");
    const code2 = mail.filter((m) => m.to === "once@example.com").pop()!.text.match(/\d{6}/)![0];
    await c.finishLogin(s2.loginId, code2);
    await expect(c.finishLogin(s2.loginId, code2)).rejects.toThrow(/start again/);
  });
  it("limits how many codes can be asked for", async () => {
    const c = client();
    for (let i = 0; i < 5; i++) await c.startLogin("spam@example.com");
    await expect(c.startLogin("spam@example.com")).rejects.toThrow(/Too many codes/);
  });
  it("nothing in the vault works without logging in, and logging out ends the login", async () => {
    const c = client();
    await expect(c.account()).rejects.toThrow(/log in/);
    await login(c, "out@example.com");
    await c.account();
    const token = c.token;
    await c.logout();
    c.token = token;
    await expect(c.account()).rejects.toThrow(/log in/);
  });
});

describe("saving, sharing and opening", () => {
  let alice: Awaited<ReturnType<typeof setUp>>;
  let bob: Awaited<ReturnType<typeof setUp>>;
  let docId: string;

  beforeAll(async () => {
    alice = await setUp("alice@example.com");
  });

  it("saves a sealed agreement locked on the device; the server holds nothing readable", async () => {
    docId = await alice.c.save(alice.me, sealed, { name: "Founders agreement.pdf", ...facts });
    const docs = await alice.c.list(alice.me);
    expect(docs).toHaveLength(1);
    expect(docs[0].meta?.name).toBe("Founders agreement.pdf");
    expect(docs[0].meta?.manifestDigest).toBe(facts.manifestDigest);
    const opened = await alice.c.open(docs[0]);
    expect(Buffer.from(opened).equals(Buffer.from(sealed))).toBe(true);

    const dump = await serverDump();
    expect(dump).not.toContain("Founders agreement");
    expect(dump).not.toContain(facts.manifestDigest);
    expect(dump).not.toContain(facts.documentId);
    expect(dump).not.toContain("%PDF");
    expect(dump).not.toContain("alice@example.com");
  });

  it("invites the other signer by email when they have no vault yet", async () => {
    const [doc] = await alice.c.list(alice.me);
    const r = await alice.c.addPerson(alice.me, doc, "bob@example.com");
    expect(r.invited).toBe(true);
    expect(mail.some((m) => m.to === "bob@example.com" && /waiting for you/.test(m.subject) && m.text.includes("https://pagelock.test/vault/"))).toBe(true);
    expect(await serverDump()).not.toContain("bob@example.com");
  });

  it("once they set up, both see the same safety code, and access is given only by a signer with the key", async () => {
    bob = await setUp("bob@example.com");
    let [bobsView] = await bob.c.list(bob.me);
    expect(bobsView.hasAccess).toBe(false);
    await expect(bob.c.open(bobsView)).rejects.toThrow(/key/);

    const [doc] = await alice.c.list(alice.me);
    const person = doc.others[0];
    expect(person.status).toBe("needs-access");
    expect(person.label).toBe("bob@example.com");
    expect(person.safetyCode).toBe(await safetyCode(bob.me.publicKey, alice.me.publicKey));

    await alice.c.giveAccess(doc, person.memberId, person.publicKey!);
    [bobsView] = await bob.c.list(bob.me);
    expect(bobsView.hasAccess).toBe(true);
    expect(bobsView.meta?.name).toBe("Founders agreement.pdf");
    expect(Buffer.from(await bob.c.open(bobsView)).equals(Buffer.from(sealed))).toBe(true);
    const [again] = await alice.c.list(alice.me);
    expect(again.others[0].status).toBe("has-access");
    // Bob sees the same safety code on his side.
    expect(bobsView.others[0].safetyCode).toBe(person.safetyCode);
  });

  it("a stranger cannot see or open the document", async () => {
    const eve = await setUp("eve@example.com");
    expect(await eve.c.list(eve.me)).toHaveLength(0);
    await expect(
      (async () => {
        const r = await fetchAs(eve.c, `/api/vault/docs/${docId}/file`);
        if (!r.ok) throw new Error(String(r.status));
      })(),
    ).rejects.toThrow("404");
  });

  it("refuses a key wrapped for an old padlock", async () => {
    const [doc] = await alice.c.list(alice.me);
    const stale = await deriveIdentity(newRoot());
    await expect(alice.c.giveAccess(doc, doc.others[0].memberId, stale.publicKey)).rejects.toThrow(/keys have changed/);
  });

  it("losing every key: new keys can be made, and the other signer can give access again", async () => {
    // Bob lost his phone and his words. He logs in again by email and starts again with new keys.
    const c = client();
    await login(c, "bob@example.com");
    const newMe: VaultIdentity = await deriveIdentity(newRoot());
    await expect(c.setKey(newMe)).rejects.toThrow(/already has keys/);
    await c.setKey(newMe, true);
    let [view] = await c.list(newMe);
    expect(view.hasAccess).toBe(false);

    const [doc] = await alice.c.list(alice.me);
    expect(doc.others[0].status).toBe("needs-access");
    expect(doc.others[0].safetyCode).toBe(await safetyCode(alice.me.publicKey, newMe.publicKey));
    await alice.c.giveAccess(doc, doc.others[0].memberId, doc.others[0].publicKey!);
    [view] = await c.list(newMe);
    expect(Buffer.from(await c.open(view)).equals(Buffer.from(sealed))).toBe(true);
  });

  it("recovery words on a new device open everything again", async () => {
    const c = client();
    await login(c, "alice@example.com");
    const restored = await deriveIdentity(wordsToRoot(rootToWords(alice.root).join(" ")));
    const account = await c.account();
    expect(restored.keyFp).toBe(account.keyFp);
    const [doc] = await c.list(restored);
    expect(Buffer.from(await c.open(doc)).equals(Buffer.from(sealed))).toBe(true);
  });

  it("removing a document takes it out of my vault only; the file goes when nobody is left", async () => {
    await bob.c.remove(docId).catch(() => undefined); // bob's old login still works; remove his membership
    const c = client();
    await login(c, "bob@example.com");
    expect((await c.list(await deriveIdentity(newRoot()))).length).toBe(0);
    expect(await vaultStore.getDoc(docId)).not.toBeNull();
    await alice.c.remove(docId);
    expect(await vaultStore.getDoc(docId)).toBeNull();
    expect(await vaultStore.getFile(docId)).toBeNull();
  });
});

async function fetchAs(c: VaultClient, path: string) {
  return service.handle(new Request("https://service.test" + path, { headers: { Authorization: `Bearer ${c.token}` } }));
}
