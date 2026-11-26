import Link from "next/link";
import type { Outcome } from "@/lib/pagelock";
import {
  ArrowRightIcon,
  CameraIcon,
  EyeIcon,
  FileSealIcon,
  KeyIcon,
  LayersIcon,
  LinkIcon,
  LockIcon,
  PenIcon,
  QrIcon,
  SearchCheckIcon,
  ShieldCheckIcon,
} from "@/components/icons";
import { OutcomeBadge } from "@/components/ui";

const LEVELS: [Outcome, string][] = [
  ["VERIFIED", "Every page is intact and both founders have valid, trusted, timestamped signatures on this exact file."],
  ["REFERENCE MATCH", "Every page matches the trusted reference you kept. Who signed is not established."],
  ["INTERNALLY CONSISTENT", "The seals agree with each other, but nothing trusted was checked."],
  ["ALTERED / INVALID", "A page, the order or the reference does not match."],
  ["UNABLE TO VERIFY", "Not enough evidence or an unsupported file. Never treated as a pass."],
];

const STEPS = [
  {
    href: "/create/",
    Icon: FileSealIcon,
    step: "Step 1",
    title: "Create a sealed copy",
    text: "Choose your PDF. You get the sealed PDF to share and a reference file to keep somewhere safe.",
    cta: "Start",
    tint: "from-indigo-500 to-indigo-700",
    bar: "border-indigo-500",
  },
  {
    href: "/sign/",
    Icon: PenIcon,
    step: "Step 2",
    title: "Both founders sign",
    text: "Each founder reads every page, agrees once to the whole document and adds a digital signature. The sign-off is logged: signed, then double signed.",
    cta: "Sign",
    tint: "from-violet-500 to-violet-700",
    bar: "border-violet-500",
  },
  {
    href: "/verify/",
    Icon: SearchCheckIcon,
    step: "Step 3",
    title: "Check a copy",
    text: "Choose a sealed PDF and, ideally, the reference file you kept. PageLock checks every page and tells you what it found.",
    cta: "Check",
    tint: "from-emerald-500 to-emerald-700",
    bar: "border-emerald-500",
  },
];

const PERKS = [
  { Icon: EyeIcon, text: "Nothing is uploaded" },
  { Icon: QrIcon, text: "A seal on every page" },
  { Icon: LinkIcon, text: "Pages linked in order" },
  { Icon: KeyIcon, text: "Signed and timestamped" },
];

/** Three sealed pages, each with a QR seal, linked to the next. Decorative only. */
function HeroArt() {
  const page = (x: number, y: number, r: number, n: number) => (
    <g transform={`translate(${x} ${y}) rotate(${r} 70 95)`}>
      <rect width="140" height="190" rx="10" fill="white" stroke="#e2e8f0" strokeWidth="1.5" />
      {[26, 40, 54, 68, 82, 96].map((ly, i) => (
        <rect key={ly} x="16" y={ly} width={i % 3 === 2 ? 70 : 108} height="6" rx="3" fill="#e2e8f0" />
      ))}
      <rect x="0" y="140" width="140" height="50" rx="0" fill="#eef2ff" />
      <rect x="0" y="180" width="140" height="10" rx="0" fill="#eef2ff" />
      <path d="M0 140h140" stroke="#c7d2fe" strokeWidth="1.5" />
      <g transform="translate(12 148)" fill="#4338ca">
        <rect width="34" height="34" rx="3" fill="white" stroke="#c7d2fe" />
        <rect x="4" y="4" width="10" height="10" rx="1" />
        <rect x="20" y="4" width="10" height="10" rx="1" />
        <rect x="4" y="20" width="10" height="10" rx="1" />
        <rect x="20" y="20" width="4" height="4" />
        <rect x="26" y="26" width="4" height="4" />
      </g>
      <rect x="54" y="152" width="70" height="5" rx="2.5" fill="#a5b4fc" />
      <rect x="54" y="163" width="48" height="5" rx="2.5" fill="#c7d2fe" />
      <text x="54" y="182" fontSize="9" fontFamily="ui-monospace, monospace" fill="#6366f1">
        page {n} of 3
      </text>
    </g>
  );
  return (
    <svg viewBox="0 0 380 300" className="h-auto w-full max-w-md drop-shadow-xl" aria-hidden="true">
      <defs>
        <linearGradient id="hl" x1="0" x2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#10b981" />
        </linearGradient>
      </defs>
      {page(20, 70, -8, 1)}
      {page(120, 45, 0, 2)}
      {page(220, 70, 8, 3)}
      <path d="M95 255 C 130 285, 160 285, 190 262 S 255 240, 290 262" fill="none" stroke="url(#hl)" strokeWidth="3" strokeDasharray="6 6" strokeLinecap="round" />
      <g transform="translate(300 8)">
        <circle cx="30" cy="30" r="30" fill="#10b981" />
        <path d="M17 31l9 9 17-19" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

export default function Home() {
  return (
    <div className="space-y-14">
      <section className="grid items-center gap-8 md:grid-cols-[1.1fr_1fr]">
        <div className="space-y-5">
          <span className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200">
            <LockIcon size={14} /> Tamper-evident agreements
          </span>
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-5xl">
            Every page <span className="bg-gradient-to-r from-indigo-600 to-emerald-500 bg-clip-text text-transparent">accounted for.</span>
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-slate-600">
            PageLock adds a small seal to the bottom of every page of an agreement. Each seal carries a fingerprint of its
            page and links to the pages before and after it, so a swapped, missing, added, reordered or edited page shows
            up straight away.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/create/"
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-indigo-600/25 transition hover:bg-indigo-700"
            >
              <FileSealIcon size={18} /> Seal a document
            </Link>
            <Link
              href="/verify/"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 transition hover:border-indigo-400 hover:text-indigo-700"
            >
              <SearchCheckIcon size={18} /> Check a copy
            </Link>
          </div>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2 pt-1 text-sm text-slate-600 sm:flex sm:flex-wrap">
            {PERKS.map(({ Icon, text }) => (
              <li key={text} className="flex items-center gap-1.5">
                <Icon size={16} className="text-emerald-600" />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-center">
          <HeroArt />
        </div>
      </section>

      <section className="space-y-5 rounded-3xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 p-5 shadow-xl shadow-slate-900/20 sm:p-8">
        <div className="flex items-center gap-2">
          <LayersIcon size={20} className="text-indigo-300" />
          <h2 className="text-xl font-bold tracking-tight text-white">How it works</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {STEPS.map(({ href, Icon, step, title, text, cta, tint, bar }) => (
            <Link
              key={href}
              href={href}
              className={`group flex flex-col rounded-2xl border-t-4 bg-white p-6 shadow-lg transition hover:-translate-y-0.5 hover:shadow-2xl ${bar}`}
            >
              <div className="flex items-center justify-between">
                <span className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ${tint}`}>
                  <Icon size={22} />
                </span>
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{step}</span>
              </div>
              <div className="mt-4 text-lg font-bold text-slate-900">{title}</div>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-600">{text}</p>
              <div className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-700">
                {cta}
                <ArrowRightIcon size={16} className="transition group-hover:translate-x-1" />
              </div>
            </Link>
          ))}
        </div>
      </section>

      <Link
        href="/photo/"
        className="group flex flex-wrap items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow-md sm:p-6"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-sky-700 text-white shadow-sm">
          <CameraIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-bold text-slate-900">New: sealed photos</div>
          <p className="text-sm leading-relaxed text-slate-600">
            Photograph a licence, passport or document inside PageLock. It is sealed the moment it is taken, so anyone can
            check later that not one pixel has changed.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-700">
          Take a photo <ArrowRightIcon size={16} className="transition group-hover:translate-x-1" />
        </span>
      </Link>

      <section className="space-y-5">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon size={20} className="text-indigo-600" />
          <h2 className="text-xl font-bold tracking-tight text-slate-900">What the results mean</h2>
        </div>
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-300/70 bg-white shadow-md shadow-slate-900/5">
          {LEVELS.map(([name, text]) => (
            <li key={name} className="flex flex-col gap-2 px-5 py-4 text-sm sm:flex-row sm:items-center sm:gap-4">
              <div className="sm:w-60 sm:shrink-0">
                <OutcomeBadge outcome={name} />
              </div>
              <span className="text-slate-700">{text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex gap-4 rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5 text-sm leading-relaxed text-amber-950 shadow-sm sm:p-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
          <KeyIcon size={20} />
        </span>
        <p>
          <strong className="block text-base">Keep your reference file.</strong>
          A sealed PDF on its own can be rebuilt by someone who changes the wording and seals it again. The reference file
          (or its short digest, which you can email to the other founder) is what lets you prove a copy is the one you agreed.
        </p>
      </section>
    </div>
  );
}
