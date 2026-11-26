import Link from "next/link";

const LEVELS: [string, string, string][] = [
  ["VERIFIED", "bg-emerald-600", "Content and the required trusted signatures all pass. (Needs signing, coming in Phase 2.)"],
  ["REFERENCE MATCH", "bg-emerald-500", "Every page matches the trusted reference you kept. Who signed is not established."],
  ["INTERNALLY CONSISTENT", "bg-sky-600", "The seals agree with each other, but nothing trusted was checked."],
  ["ALTERED / INVALID", "bg-red-600", "A page, the order or the reference does not match."],
  ["UNABLE TO VERIFY", "bg-neutral-500", "Not enough evidence or an unsupported file. Never treated as a pass."],
];

export default function Home() {
  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Every page accounted for.</h1>
        <p className="max-w-2xl text-neutral-700">
          PageLock adds a small seal to the bottom of every page of an agreement. Each seal carries a fingerprint of its
          page and links to the pages before and after it, so a swapped, missing, added, reordered or edited page shows
          up straight away.
        </p>
      </section>
      <section className="grid gap-4 sm:grid-cols-2">
        <Link href="/create/" className="group rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:border-neutral-400">
          <div className="text-sm font-medium text-neutral-500">Step 1</div>
          <div className="mt-1 text-xl font-semibold">Create a sealed copy</div>
          <p className="mt-2 text-sm text-neutral-600">
            Choose your PDF. You get the sealed PDF to share and a reference file to keep somewhere safe.
          </p>
          <div className="mt-4 text-sm font-medium text-neutral-900 group-hover:underline">Start →</div>
        </Link>
        <Link href="/verify/" className="group rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:border-neutral-400">
          <div className="text-sm font-medium text-neutral-500">Step 2</div>
          <div className="mt-1 text-xl font-semibold">Check a copy</div>
          <p className="mt-2 text-sm text-neutral-600">
            Choose a sealed PDF and, ideally, the reference file you kept. PageLock checks every page and tells you what it found.
          </p>
          <div className="mt-4 text-sm font-medium text-neutral-900 group-hover:underline">Check →</div>
        </Link>
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">What the results mean</h2>
        <ul className="space-y-2">
          {LEVELS.map(([name, color, text]) => (
            <li key={name} className="flex items-start gap-3 text-sm">
              <span className={`mt-0.5 shrink-0 rounded px-2 py-0.5 text-xs font-semibold text-white ${color}`}>{name}</span>
              <span className="text-neutral-700">{text}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
        <strong>Keep your reference file.</strong> A sealed PDF on its own can be rebuilt by someone who changes the
        wording and seals it again. The reference file (or its short digest, which you can email to the other founder)
        is what lets you prove a copy is the one you agreed.
      </section>
    </div>
  );
}
