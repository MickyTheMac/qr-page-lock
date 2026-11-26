"use client";
import { useRef, useState } from "react";

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
      className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
        over ? "border-neutral-900 bg-neutral-100" : "border-neutral-300 bg-white hover:border-neutral-500"
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
      <div className="font-medium">{file ? file.name : label}</div>
      <div className="mt-1 text-sm text-neutral-500">{file ? `${(file.size / 1024).toFixed(0)} KB · click to change` : hint}</div>
    </div>
  );
}
