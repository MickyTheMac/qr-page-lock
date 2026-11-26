"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AccountInfo,
  VaultApiError,
  VaultDocument,
  VaultIdentity,
  VaultPerson,
  deriveIdentity,
  groupDocId,
  newRoot,
  rootToWords,
  shortFingerprint,
  verifyPdf,
  wordsToRoot,
} from "@/lib/pagelock";
import { createPasskey, forgetRoot, passkeysAvailable, recallRoot, rememberRoot, saveToken, savedToken, askPasskey } from "@/lib/pagelock/vault/device";
import { ActiveService, getService } from "@/lib/service-config";
import { baseName, download, readFile } from "@/lib/download";
import { FileDrop } from "@/components/FileDrop";
import { Notice, PageHeader, btnPrimary, btnSecondary, card, inputCls, linkBtn } from "@/components/ui";
import { CheckCircleIcon, DownloadIcon, FileIcon, KeyIcon, LockIcon, MailIcon, ShieldCheckIcon, SpinnerIcon, UsersIcon } from "@/components/icons";

/**
 * The vault: save sealed agreements so either signer can get them back later.
 * Everything is locked on this device before upload; PageLock stores only locked boxes it cannot open.
 */

type Phase =
  | { kind: "loading" }
  | { kind: "email" }
  | { kind: "code"; email: string; loginId: string; demoCode?: string }
  | { kind: "setup"; replace: boolean }
  | { kind: "unlock" }
  | { kind: "ready" };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function VaultPage() {
  const [svc, setSvc] = useState<ActiveService | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [root, setRoot] = useState<Uint8Array | null>(null);
  const [me, setMe] = useState<VaultIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loggedOut = useCallback(() => {
    saveToken(null);
    setAccount(null);
    setRoot(null);
    setMe(null);
    setPhase({ kind: "email" });
  }, []);

  /** After login: decide between first-time setup, unlocking this device, or straight to the vault. */
  const afterLogin = useCallback(async (s: ActiveService, acc: AccountInfo) => {
    setAccount(acc);
    if (!acc.keyFp) return setPhase({ kind: "setup", replace: false });
    const r = await recallRoot(acc.keyFp);
    if (r) {
      setRoot(r);
      setMe(await deriveIdentity(r));
      return setPhase({ kind: "ready" });
    }
    setPhase({ kind: "unlock" });
  }, []);

  useEffect(() => {
    (async () => {
      const s = await getService();
      setSvc(s);
      const t = savedToken();
      if (!t) return setPhase({ kind: "email" });
      s.vault.token = t;
      try {
        await afterLogin(s, await s.vault.account());
      } catch (e) {
        if (e instanceof VaultApiError && e.status === 401) return loggedOut();
        setError(errText(e));
        setPhase({ kind: "email" });
      }
    })();
  }, [afterLogin, loggedOut]);

  const unlocked = async (r: Uint8Array) => {
    if (!svc || !account?.keyFp) return;
    const id = await deriveIdentity(r);
    if (id.keyFp !== account.keyFp) throw new Error("These words belong to different keys from this account's. Please check them.");
    await rememberRoot(r, id.keyFp);
    setRoot(r);
    setMe(id);
    setPhase({ kind: "ready" });
  };

  const lockDevice = async () => {
    await forgetRoot();
    setRoot(null);
    setMe(null);
    setPhase({ kind: "unlock" });
  };

  const logout = async () => {
    await forgetRoot();
    await svc?.vault.logout().catch(() => undefined);
    loggedOut();
  };

  return (
    <div className="space-y-6">
      <PageHeader tone="slate" icon={<LockIcon size={24} />} title="Your vault">
        Keep your sealed agreements safe and get them back later, on any device. Each file is locked on your own device
        before it is saved, so <strong>PageLock cannot open it</strong>. Only you and the people you share it with can.
      </PageHeader>

      {svc?.demo && (
        <Notice tone="warn" title="Demo vault">
          This try-out keeps the vault in this browser tab only, and it empties when you reload. Codes are shown on screen
          instead of being emailed.
        </Notice>
      )}
      {error && (
        <Notice tone="error" title="Something went wrong">
          {error}
        </Notice>
      )}

      {phase.kind === "loading" && (
        <div className="flex items-center gap-2 text-slate-500">
          <SpinnerIcon /> Loading…
        </div>
      )}

      {svc && phase.kind === "email" && (
        <EmailStep
          svc={svc}
          onSent={(email, r) => {
            setError(null);
            setPhase({ kind: "code", email, loginId: r.loginId, demoCode: r.demoCode });
          }}
        />
      )}

      {svc && phase.kind === "code" && (
        <CodeStep
          svc={svc}
          phase={phase}
          onBack={() => setPhase({ kind: "email" })}
          onDone={async (token, acc) => {
            saveToken(token);
            setError(null);
            await afterLogin(svc, acc);
          }}
        />
      )}

      {svc && phase.kind === "setup" && (
        <SetupStep
          svc={svc}
          replace={phase.replace}
          onDone={async (r, acc) => {
            setAccount(acc);
            const id = await deriveIdentity(r);
            await rememberRoot(r, id.keyFp);
            setRoot(r);
            setMe(id);
            setPhase({ kind: "ready" });
          }}
          onCancel={phase.replace ? () => setPhase({ kind: "unlock" }) : undefined}
        />
      )}

      {svc && account && phase.kind === "unlock" && (
        <UnlockStep svc={svc} account={account} onUnlock={unlocked} onStartAgain={() => setPhase({ kind: "setup", replace: true })} onLogout={logout} />
      )}

      {svc && account && root && me && phase.kind === "ready" && (
        <Vault svc={svc} account={account} setAccount={setAccount} root={root} me={me} onLock={lockDevice} onLogout={logout} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- login

function EmailStep({ svc, onSent }: { svc: ActiveService; onSent: (email: string, r: { loginId: string; demoCode?: string }) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className={`${card} max-w-lg space-y-4`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          onSent(email.trim(), await svc.vault.startLogin(email.trim()));
        } catch (x) {
          setErr(errText(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex items-center gap-2 font-semibold text-slate-900">
        <MailIcon size={20} className="text-slate-400" /> Log in with your email
      </div>
      <p className="text-sm text-slate-600">We will email you a 6-digit code. There is no password. PageLock keeps only a scrambled form of your address.</p>
      <input className={inputCls} type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email address" />
      {err && <p className="text-sm text-red-700">{err}</p>}
      <button className={btnPrimary} disabled={busy || !email.includes("@")}>
        {busy ? <SpinnerIcon size={16} /> : <MailIcon size={16} />} Email me a code
      </button>
    </form>
  );
}

function CodeStep({
  svc,
  phase,
  onBack,
  onDone,
}: {
  svc: ActiveService;
  phase: { email: string; loginId: string; demoCode?: string };
  onBack: () => void;
  onDone: (token: string, acc: AccountInfo) => Promise<void>;
}) {
  const [code, setCode] = useState(phase.demoCode ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className={`${card} max-w-lg space-y-4`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          const r = await svc.vault.finishLogin(phase.loginId, code);
          await onDone(r.token, r.account);
        } catch (x) {
          setErr(errText(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="font-semibold text-slate-900">Enter the code we emailed to {phase.email}</div>
      {phase.demoCode && <p className="text-sm text-amber-800">Demo: your code is {phase.demoCode}</p>}
      <input
        className={`${inputCls} max-w-[12rem] text-center font-mono text-lg tracking-[0.4em]`}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        aria-label="6-digit code"
        autoFocus
      />
      {err && <p className="text-sm text-red-700">{err}</p>}
      <div className="flex flex-wrap gap-3">
        <button className={btnPrimary} disabled={busy || code.length !== 6}>
          {busy && <SpinnerIcon size={16} />} Log in
        </button>
        <button type="button" className={btnSecondary} onClick={onBack}>
          Use a different email
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- first-time setup: recovery sheet

function SetupStep({
  svc,
  replace,
  onDone,
  onCancel,
}: {
  svc: ActiveService;
  replace: boolean;
  onDone: (root: Uint8Array, acc: AccountInfo) => Promise<void>;
  onCancel?: () => void;
}) {
  const root = useMemo(() => newRoot(), []);
  const words = useMemo(() => rootToWords(root), [root]);
  const [checks] = useState(() => {
    const a = Math.floor(Math.random() * 12);
    return [a, 12 + Math.floor(Math.random() * 12)];
  });
  const [kept, setKept] = useState(false);
  const [answers, setAnswers] = useState(["", ""]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answered = checks.every((n, i) => answers[i].trim().toLowerCase() === words[n]);

  return (
    <div className="space-y-4">
      {replace && (
        <Notice tone="warn" title="Starting again with new keys">
          Your old keys will stop working. Documents saved before cannot be opened with the new keys until the other signer
          gives you access again. They will see a new safety code to compare with you.
        </Notice>
      )}
      <section className={`${card} space-y-4`}>
        <div className="flex items-center gap-2 font-semibold text-slate-900">
          <KeyIcon size={20} className="text-slate-400" /> Your recovery sheet
        </div>
        <p className="text-sm text-slate-600">
          These 24 words are the only way to open your vault on a new device if you lose this one.{" "}
          <strong>PageLock never sees them and cannot give them back.</strong> Print this page or write the words down, in order,
          and keep them with your paper agreement.
        </p>
        <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl bg-slate-50 p-4 font-mono text-sm sm:grid-cols-3 print:grid-cols-3" data-testid="recovery-words">
          {words.map((w, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-6 text-right text-slate-400">{i + 1}.</span>
              <span className="font-semibold text-slate-900">{w}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-3 print:hidden">
          <button type="button" className={btnSecondary} onClick={() => window.print()}>
            Print recovery sheet
          </button>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700 print:hidden">
          <input type="checkbox" className="mt-1" checked={kept} onChange={(e) => setKept(e.target.checked)} />I have printed or written
          down all 24 words and will keep them somewhere safe.
        </label>
      </section>

      {kept && (
        <form
          className={`${card} space-y-4 print:hidden`}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              const acc = await svc.vault.setKey(await deriveIdentity(root), replace);
              await onDone(root, acc);
            } catch (x) {
              setErr(errText(x));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="font-semibold text-slate-900">Quick check</div>
          <div className="flex flex-wrap gap-4">
            {checks.map((n, i) => (
              <label key={n} className="space-y-1 text-sm text-slate-700">
                <span>Word {n + 1}</span>
                <input
                  className={`${inputCls} w-40 font-mono`}
                  value={answers[i]}
                  autoComplete="off"
                  onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
                  aria-label={`Word ${n + 1}`}
                />
              </label>
            ))}
          </div>
          {err && <p className="text-sm text-red-700">{err}</p>}
          <div className="flex flex-wrap gap-3">
            <button className={btnPrimary} disabled={busy || !answered}>
              {busy ? <SpinnerIcon size={16} /> : <LockIcon size={16} />} Create my vault
            </button>
            {onCancel && (
              <button type="button" className={btnSecondary} onClick={onCancel}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- unlocking on this device

function UnlockStep({
  svc,
  account,
  onUnlock,
  onStartAgain,
  onLogout,
}: {
  svc: ActiveService;
  account: AccountInfo;
  onUnlock: (root: Uint8Array) => Promise<void>;
  onStartAgain: () => void;
  onLogout: () => void;
}) {
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const canPasskey = account.passkeys.length > 0 && passkeysAvailable();
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`${card} max-w-2xl space-y-4`}>
      <div className="flex items-center gap-2 font-semibold text-slate-900">
        <KeyIcon size={20} className="text-slate-400" /> Unlock your vault on this device
      </div>
      {canPasskey && (
        <button
          className={btnPrimary}
          disabled={busy}
          onClick={() =>
            run(async () => {
              const got = await askPasskey(account.passkeys);
              if (!got) throw new Error("The passkey did not give a key. Try your recovery words instead.");
              await onUnlock(await svc.vault.rootFromPasskey(account, got.id, got.prf));
            })
          }
        >
          <KeyIcon size={16} /> Unlock with your passkey
        </button>
      )}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => onUnlock(wordsToRoot(words)));
        }}
      >
        <label className="block space-y-1 text-sm text-slate-700">
          <span>{canPasskey ? "Or type" : "Type"} your 24 recovery words, in order</span>
          <textarea className={`${inputCls} h-28 font-mono`} value={words} onChange={(e) => setWords(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Recovery words" />
        </label>
        <button className={btnSecondary} disabled={busy || !words.trim()}>
          {busy && <SpinnerIcon size={16} />} Unlock with recovery words
        </button>
      </form>
      {err && <p className="text-sm text-red-700">{err}</p>}
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-slate-100 pt-4 text-sm">
        <button className={linkBtn} onClick={() => setLost(!lost)}>
          I have lost my recovery words and passkey
        </button>
        <button className={linkBtn} onClick={onLogout}>
          Log out
        </button>
      </div>
      {lost && (
        <Notice tone="warn" title="Nobody can recover your old keys, not even PageLock">
          <p>
            That is what keeps your files private. You can start again with new keys. The other signer can then give you access
            to your shared documents again, after you compare a new safety code.
          </p>
          <button className={`${btnSecondary} mt-2`} onClick={onStartAgain}>
            Start again with new keys
          </button>
        </Notice>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the vault

function Vault({
  svc,
  account,
  setAccount,
  root,
  me,
  onLock,
  onLogout,
}: {
  svc: ActiveService;
  account: AccountInfo;
  setAccount: (a: AccountInfo) => void;
  root: Uint8Array;
  me: VaultIdentity;
  onLock: () => void;
  onLogout: () => void;
}) {
  const [docs, setDocs] = useState<VaultDocument[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pkBusy, setPkBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setDocs(await svc.vault.list(me));
    } catch (x) {
      setErr(errText(x));
    }
  }, [svc, me]);
  useEffect(() => {
    let live = true;
    svc.vault.list(me).then(
      (d) => live && setDocs(d),
      (x) => live && setErr(errText(x)),
    );
    return () => {
      live = false;
    };
  }, [svc, me]);

  const addPasskey = async () => {
    setPkBusy(true);
    setErr(null);
    try {
      const pk = await createPasskey();
      if (!pk) throw new Error("This device's passkeys cannot hold a key for the vault. Keep using your recovery words.");
      setAccount(await svc.vault.addPasskey(me, root, pk));
      setNote("Passkey added. On a new device you can now unlock with it instead of typing your words.");
    } catch (x) {
      setErr(x instanceof DOMException && x.name === "NotAllowedError" ? "The passkey was not created." : errText(x));
    } finally {
      setPkBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className={`${card} flex flex-wrap items-center gap-3`}>
        <ShieldCheckIcon size={22} className="text-emerald-600" />
        <div className="min-w-0 flex-1 text-sm text-slate-700">
          <div className="font-semibold text-slate-900">Unlocked on this device</div>
          Your padlock: <span className="font-mono">{shortFingerprint(me.keyFp.toUpperCase())}</span>
          {account.passkeys.length > 0 && ` · ${account.passkeys.length} passkey${account.passkeys.length > 1 ? "s" : ""}`}
        </div>
        {passkeysAvailable() && (
          <button className={btnSecondary} onClick={addPasskey} disabled={pkBusy}>
            {pkBusy ? <SpinnerIcon size={16} /> : <KeyIcon size={16} />} Add a passkey
          </button>
        )}
        <button className={btnSecondary} onClick={onLock}>
          Lock
        </button>
        <button className={btnSecondary} onClick={onLogout}>
          Log out
        </button>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {note && <Notice tone="success">{note}</Notice>}

      <SaveBox svc={svc} me={me} onSaved={refresh} />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Saved documents</h2>
        {docs === null && (
          <div className="flex items-center gap-2 text-slate-500">
            <SpinnerIcon /> Opening your vault…
          </div>
        )}
        {docs?.length === 0 && <p className="text-sm text-slate-500">Nothing saved yet.</p>}
        {docs?.map((d) => <DocCard key={d.id} svc={svc} me={me} doc={d} onChange={refresh} />)}
      </section>
    </div>
  );
}

function SaveBox({ svc, me, onSaved }: { svc: ActiveService; me: VaultIdentity; onSaved: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  return (
    <section className={`${card} space-y-3`}>
      <div className="font-semibold text-slate-900">Save a sealed agreement</div>
      <FileDrop
        label="Choose a sealed PDF"
        hint="A document sealed with PageLock (up to 3 MB)"
        accept="application/pdf,.pdf"
        file={file}
        onFile={async (f) => {
          setFile(f);
          setMsg(null);
          if (!f) return;
          setBusy(true);
          try {
            const bytes = await readFile(f);
            if (bytes.length > 3 * 1024 * 1024 - 1024) throw new Error("This file is too big for the vault (over 3 MB).");
            const r = await verifyPdf(bytes);
            if (r.outcome === "ALTERED / INVALID") throw new Error("This copy fails PageLock's checks, so it was not saved. Save the genuine copy instead.");
            if (!r.documentId || !r.manifestDigest) throw new Error("This is not a PageLock-sealed document. Seal it on the Create page first.");
            await svc.vault.save(me, bytes, { name: f.name, documentId: r.documentId, manifestDigest: r.manifestDigest });
            setMsg({ tone: "success", text: `Locked on this device and saved: ${f.name}` });
            setFile(null);
            onSaved();
          } catch (x) {
            setMsg({ tone: "error", text: errText(x) });
          } finally {
            setBusy(false);
          }
        }}
      />
      {busy && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <SpinnerIcon size={16} /> Checking and locking…
        </div>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </section>
  );
}

function DocCard({ svc, me, doc, onChange }: { svc: ActiveService; me: VaultIdentity; doc: VaultDocument; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState<{ memberId: string; publicKey: Uint8Array; safetyCode: string; label: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setMsg(null);
    try {
      await fn();
    } catch (x) {
      setMsg({ tone: "error", text: errText(x) });
    } finally {
      setBusy(null);
    }
  };

  const open = () =>
    run("open", async () => {
      const bytes = await svc.vault.open(doc);
      const r = await verifyPdf(bytes);
      if (doc.meta?.manifestDigest && r.manifestDigest !== doc.meta.manifestDigest)
        throw new Error("This file does not match the fingerprint saved with it. Do not rely on it.");
      await download(bytes, doc.meta?.name ?? "agreement.pdf", "application/pdf");
      setMsg({ tone: "success", text: "Unlocked on this device. It matches the fingerprint saved with it, and has been downloaded." });
    });

  const give = (memberId: string, publicKey: Uint8Array) =>
    run("give", async () => {
      await svc.vault.giveAccess(doc, memberId, publicKey);
      setPending(null);
      setMsg({ tone: "success", text: "Access given. They can now open it from their own vault." });
      onChange();
    });

  if (!doc.hasAccess) {
    return (
      <div className={`${card} space-y-2`}>
        <div className="flex items-center gap-2 font-semibold text-slate-900">
          <LockIcon size={18} className="text-slate-400" /> A document shared with you
        </div>
        <p className="text-sm text-slate-600">
          You cannot open this yet. Ask the person who saved it to give you access. When they do, you will both see this safety code;
          check it matches theirs:
        </p>
        {doc.others
          .filter((o) => o.safetyCode)
          .map((o) => (
            <div key={o.memberId} className="font-mono text-lg tracking-wider text-slate-900">
              {o.safetyCode}
            </div>
          ))}
        <RemoveButton confirm={confirmRemove} setConfirm={setConfirmRemove} onRemove={() => run("remove", async () => (await svc.vault.remove(doc.id), onChange()))} />
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </div>
    );
  }

  return (
    <div className={`${card} space-y-4`}>
      <div className="flex flex-wrap items-start gap-3">
        <FileIcon size={22} className="mt-0.5 text-indigo-500" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-slate-900">{doc.meta ? baseName(doc.meta.name) : "Document"}</div>
          <div className="text-xs text-slate-500">
            Saved {new Date(doc.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
            {doc.meta?.documentId && <> · Document {groupDocId(doc.meta.documentId)}</>}
            {doc.meta?.manifestDigest && (
              <>
                {" "}
                · Fingerprint <span className="font-mono">{shortFingerprint(doc.meta.manifestDigest)}</span>
              </>
            )}
          </div>
        </div>
        <button className={btnPrimary} onClick={open} disabled={!!busy}>
          {busy === "open" ? <SpinnerIcon size={16} /> : <DownloadIcon size={16} />} Open
        </button>
        <button className={btnSecondary} onClick={() => setSharing(!sharing)}>
          <UsersIcon size={16} /> Share
        </button>
      </div>

      {doc.others.length > 0 && (
        <ul className="space-y-2 border-t border-slate-100 pt-3 text-sm">
          {doc.others.map((o) => (
            <PersonRow key={o.memberId} person={o} busy={busy === "give"} onGive={() => o.publicKey && give(o.memberId, o.publicKey)} />
          ))}
        </ul>
      )}

      {sharing && !pending && (
        <form
          className="space-y-2 border-t border-slate-100 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            run("share", async () => {
              const r = await svc.vault.addPerson(me, doc, email.trim());
              if (r.publicKey && r.safetyCode) setPending({ memberId: r.memberId, publicKey: r.publicKey, safetyCode: r.safetyCode, label: email.trim() });
              else {
                setMsg({
                  tone: "info",
                  text: `${email.trim()} does not have a vault yet. We have emailed them an invite. When they have set one up, come back here to give them access.`,
                });
                onChange();
              }
              setEmail("");
              setSharing(false);
            });
          }}
        >
          <label className="block space-y-1 text-sm text-slate-700">
            <span>The other signer&apos;s email address</span>
            <input className={inputCls} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button className={btnPrimary} disabled={busy === "share" || !email.includes("@")}>
            {busy === "share" ? <SpinnerIcon size={16} /> : <MailIcon size={16} />} Continue
          </button>
        </form>
      )}

      {pending && (
        <SafetyCheck
          label={pending.label}
          code={pending.safetyCode}
          busy={busy === "give"}
          onConfirm={() => give(pending.memberId, pending.publicKey)}
          onCancel={() => {
            setPending(null);
            onChange();
          }}
        />
      )}

      <RemoveButton confirm={confirmRemove} setConfirm={setConfirmRemove} onRemove={() => run("remove", async () => (await svc.vault.remove(doc.id), onChange()))} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

function PersonRow({ person, busy, onGive }: { person: VaultPerson; busy: boolean; onGive: () => void }) {
  const [checking, setChecking] = useState(false);
  const name = person.label ?? "The other signer";
  return (
    <li className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <UsersIcon size={16} className="text-slate-400" />
        <span className="font-medium text-slate-800">{name}</span>
        {person.status === "has-access" && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
            <CheckCircleIcon size={12} /> Can open it
          </span>
        )}
        {person.status === "invited" && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">Invited, no vault yet</span>}
        {person.status === "needs-access" && (
          <>
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900 ring-1 ring-amber-200">Waiting for access</span>
            {!checking && (
              <button className={linkBtn} onClick={() => setChecking(true)}>
                Give access
              </button>
            )}
          </>
        )}
        {person.status === "has-access" && person.safetyCode && <span className="text-xs text-slate-500">Safety code {person.safetyCode}</span>}
      </div>
      {checking && person.safetyCode && <SafetyCheck label={name} code={person.safetyCode} busy={busy} onConfirm={onGive} onCancel={() => setChecking(false)} />}
    </li>
  );
}

function SafetyCheck({ label, code, busy, onConfirm, onCancel }: { label: string; code: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4">
      <div className="text-sm text-slate-700">
        Before giving <strong>{label}</strong> access, compare this safety code with them by phone or in person. They will see it in
        their vault.
      </div>
      <div className="font-mono text-2xl tracking-wider text-slate-900" data-testid="safety-code">
        {code}
      </div>
      <div className="text-xs text-slate-500">If the codes are different, do not continue: someone may be pretending to be them.</div>
      <div className="flex flex-wrap gap-3">
        <button className={btnPrimary} onClick={onConfirm} disabled={busy}>
          {busy ? <SpinnerIcon size={16} /> : <CheckCircleIcon size={16} />} The codes match: give access
        </button>
        <button className={btnSecondary} onClick={onCancel}>
          Not now
        </button>
      </div>
    </div>
  );
}

function RemoveButton({ confirm, setConfirm, onRemove }: { confirm: boolean; setConfirm: (v: boolean) => void; onRemove: () => void }) {
  return confirm ? (
    <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
      Remove from your vault? The other signer keeps their copy.
      <button className={btnSecondary} onClick={onRemove}>
        Yes, remove it
      </button>
      <button className={linkBtn} onClick={() => setConfirm(false)}>
        Keep it
      </button>
    </div>
  ) : (
    <button className="text-xs text-slate-500 underline underline-offset-2 hover:text-red-700" onClick={() => setConfirm(true)}>
      Remove from my vault
    </button>
  );
}

