"use client";
import { useRef, useState } from "react";
import { CheckCircleIcon, FileIcon, UploadIcon } from "./icons";

export function FileDrop({
  label,
  hint,
  accept,
  file,
  onFile,
}: {
  label: string;
  hint: string;
  accept: string;
  file: File | null;
  onFile: (f: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      onClick={() => input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
      className={`group flex cursor-pointer items-center gap-4 rounded-2xl border-2 border-dashed p-5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
        over
          ? "border-indigo-500 bg-indigo-50"
          : file
            ? "border-emerald-300 bg-emerald-50/60 hover:border-emerald-400"
            : "border-slate-300 bg-white hover:border-indigo-400 hover:bg-indigo-50/40"
      }`}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          onFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      <span
        className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition ${
          file ? "bg-white text-emerald-600 shadow-sm ring-1 ring-emerald-200" : "bg-indigo-50 text-indigo-600 group-hover:bg-indigo-100"
        }`}
      >
        {file ? <FileIcon size={24} /> : <UploadIcon size={24} />}
        {file && <CheckCircleIcon size={18} className="absolute -right-1.5 -top-1.5 rounded-full bg-white text-emerald-600" />}
      </span>
      <div className="min-w-0">
        <div className="truncate font-semibold text-slate-900">{file ? file.name : label}</div>
        <div className="mt-0.5 text-sm text-slate-500">{file ? `${(file.size / 1024).toFixed(0)} KB · click to change` : hint}</div>
      </div>
    </div>
  );
}
