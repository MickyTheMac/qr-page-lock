// Shared look-and-feel pieces: buttons, page headers, step cards, notices and result badges.
import type { ReactNode } from "react";
import type { Outcome } from "@/lib/pagelock";
import { AlertIcon, CheckCircleIcon, HelpIcon, InfoIcon, ShieldCheckIcon, XCircleIcon } from "./icons";

export const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm shadow-indigo-600/20 transition hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none";
export const btnSecondary =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 transition hover:border-indigo-400 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50";
/** Buttons that sit together: always the same width and height (stacked full-width on phones). */
export const btnRow = "grid gap-2 sm:w-fit sm:grid-flow-col sm:auto-cols-fr";
export const linkBtn = "font-medium text-indigo-700 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-700";
export const inputCls =
  "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm shadow-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-slate-400";
export const card = "rounded-2xl border border-slate-300/70 bg-white p-5 shadow-md shadow-slate-900/5 sm:p-6";

/** Each page has its own colour so the pages look different from each other. */
const TONES = {
  indigo: "from-indigo-600 via-indigo-700 to-indigo-900 shadow-indigo-900/25",
  violet: "from-violet-600 via-violet-700 to-purple-900 shadow-violet-900/25",
  emerald: "from-emerald-600 via-teal-700 to-teal-900 shadow-teal-900/25",
  sky: "from-sky-600 via-cyan-700 to-cyan-900 shadow-cyan-900/25",
  slate: "from-slate-700 via-slate-800 to-slate-950 shadow-slate-900/30",
} as const;
export type Tone = keyof typeof TONES;

export function PageHeader({ icon, title, tone = "indigo", children }: { icon: ReactNode; title: string; tone?: Tone; children?: ReactNode }) {
  return (
    <div className={`relative overflow-hidden rounded-3xl bg-gradient-to-br p-6 text-white shadow-xl sm:p-8 ${TONES[tone]}`}>
      <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-white/10" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 right-24 h-48 w-48 rounded-full bg-white/5" />
      <div className="relative flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-white ring-1 ring-white/30">
          {icon}
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
          {children && <div className="mt-1.5 max-w-2xl text-white/85 [&_a]:text-white [&_strong]:text-white">{children}</div>}
        </div>
      </div>
    </div>
  );
}

/** Each step number gets its own colour, so one step card does not look like the next. */
const STEP_LOOK = [
  { bar: "border-t-indigo-500", head: "bg-indigo-50/80 border-indigo-100", bubble: "bg-indigo-600 text-white", icon: "text-indigo-600" },
  { bar: "border-t-sky-500", head: "bg-sky-50/80 border-sky-100", bubble: "bg-sky-600 text-white", icon: "text-sky-600" },
  { bar: "border-t-violet-500", head: "bg-violet-50/80 border-violet-100", bubble: "bg-violet-600 text-white", icon: "text-violet-600" },
  { bar: "border-t-amber-500", head: "bg-amber-50/80 border-amber-100", bubble: "bg-amber-500 text-white", icon: "text-amber-600" },
];

/** A numbered step: a coloured title strip with a number bubble, an icon and a title, then content. */
export function Step({
  n,
  icon,
  title,
  hint,
  done,
  children,
  className = "",
}: {
  n: number;
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
  done?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const look = STEP_LOOK[(n - 1) % STEP_LOOK.length];
  return (
    <section
      className={`min-w-0 overflow-hidden rounded-2xl border border-t-4 border-slate-300/70 bg-white shadow-md shadow-slate-900/5 ${
        done ? "border-t-emerald-500" : look.bar
      }`}
    >
      <div className={`flex items-center gap-3 border-b px-5 py-4 sm:px-6 ${done ? "border-emerald-100 bg-emerald-50/80" : look.head}`}>
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base font-bold shadow-sm ${
            done ? "bg-emerald-500 text-white" : look.bubble
          }`}
        >
          {done ? <CheckCircleIcon size={20} /> : n}
        </span>
        <span className={done ? "text-emerald-600" : look.icon}>{icon}</span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          {hint && <p className="text-sm text-slate-600">{hint}</p>}
        </div>
      </div>
      <div className={`min-w-0 space-y-4 p-5 empty:hidden sm:p-6 ${className}`}>{children}</div>
    </section>
  );
}

const NOTICE = {
  info: ["border-sky-200 bg-sky-50 text-sky-950", "text-sky-600", InfoIcon],
  warn: ["border-amber-200 bg-amber-50 text-amber-950", "text-amber-600", AlertIcon],
  error: ["border-red-200 bg-red-50 text-red-900", "text-red-600", XCircleIcon],
  success: ["border-emerald-200 bg-emerald-50 text-emerald-950", "text-emerald-600", CheckCircleIcon],
} as const;

export function Notice({ tone, title, children, className = "" }: { tone: keyof typeof NOTICE; title?: ReactNode; children?: ReactNode; className?: string }) {
  const [box, ic, Icon] = NOTICE[tone];
  return (
    <div className={`flex gap-3 rounded-2xl border p-4 text-sm leading-relaxed ${box} ${className}`}>
      <Icon size={20} className={`mt-0.5 shrink-0 ${ic}`} />
      <div className="min-w-0 space-y-1">
        {title && <div className="font-semibold">{title}</div>}
        {children}
      </div>
    </div>
  );
}

/** How each verification outcome looks everywhere in the app. */
export const OUTCOME_LOOK: Record<Outcome, { badge: string; panel: string; icon: typeof ShieldCheckIcon; plain: string }> = {
  VERIFIED: {
    badge: "bg-emerald-600 text-white",
    panel: "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white",
    icon: ShieldCheckIcon,
    plain: "All good, and signed",
  },
  "REFERENCE MATCH": {
    badge: "bg-emerald-500 text-white",
    panel: "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white",
    icon: CheckCircleIcon,
    plain: "Matches the original",
  },
  "INTERNALLY CONSISTENT": {
    badge: "bg-sky-600 text-white",
    panel: "border-sky-200 bg-gradient-to-br from-sky-50 to-white",
    icon: InfoIcon,
    plain: "Looks consistent, not proven",
  },
  "ALTERED / INVALID": {
    badge: "bg-red-600 text-white",
    panel: "border-red-200 bg-gradient-to-br from-red-50 to-white",
    icon: XCircleIcon,
    plain: "Something has changed",
  },
  "UNABLE TO VERIFY": {
    badge: "bg-slate-600 text-white",
    panel: "border-slate-200 bg-gradient-to-br from-slate-50 to-white",
    icon: HelpIcon,
    plain: "Could not check",
  },
};

export function OutcomeBadge({ outcome, size = "sm" }: { outcome: Outcome; size?: "sm" | "lg" }) {
  const look = OUTCOME_LOOK[outcome];
  const Icon = look.icon;
  return size === "lg" ? (
    <div className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-lg font-bold tracking-wide shadow-sm ${look.badge}`}>
      <Icon size={22} />
      {outcome}
    </div>
  ) : (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold tracking-wide ${look.badge}`}>
      <Icon size={14} />
      {outcome}
    </span>
  );
}
