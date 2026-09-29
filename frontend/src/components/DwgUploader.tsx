"use client";

import { useCallback, useRef, useState } from "react";
import { UploadCloud, X } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

interface DwgUploaderProps {
  file: File | null;
  onFile: (file: File) => void;
  onClear: () => void;
  disabled?: boolean;
  maxMb: number;
}

export default function DwgUploader({ file, onFile, onClear, disabled = false, maxMb }: DwgUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) {
        return;
      }
      const candidates = Array.from(list);
      // A drop can contain several files; prefer the first .dwg in the list.
      const candidate = candidates.find((f) => /\.dwg$/i.test(f.name)) ?? candidates[0];
      if (candidate) {
        onFile(candidate);
      }
    },
    [onFile]
  );

  return file ? (
    <div className="animate-slide-up flex items-center justify-between gap-3 overflow-hidden rounded-2xl border border-border bg-card/70 px-4 py-3.5 shadow-sm ring-1 ring-primary/5 ring-inset">
      <div className="flex min-w-0 items-center gap-3">
        <span className="brand-gradient flex size-11 shrink-0 items-center justify-center rounded-xl text-white shadow-md shadow-indigo-500/25 ring-1 ring-white/10 ring-inset">
          <UploadCloud className="size-5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
            <span className="hidden rounded-md border border-primary/15 bg-primary/5 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-primary uppercase sm:inline">
              .dwg
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{(file.size / (1024 * 1024)).toFixed(1)} MB · ready to convert</p>
        </div>
      </div>
      {!disabled && (
        <Button variant="ghost" size="icon-sm" aria-label="Remove file" onClick={onClear}>
          <X />
        </Button>
      )}
    </div>
  ) : (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      className={cn(
        "group relative flex w-full cursor-pointer flex-col items-center justify-center gap-2.5 overflow-hidden rounded-2xl border-2 border-dashed border-border/80 bg-muted/30 px-4 py-8 text-center outline-none transition-all sm:gap-3 sm:px-6 sm:py-9",
        "hover:border-primary/50 focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/40",
        dragging && "border-primary bg-primary/5 ring-4 ring-primary/10",
        disabled && "pointer-events-none cursor-not-allowed opacity-50"
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300",
          dragging && "opacity-100"
        )}
      >
        <div className="brand-gradient-soft absolute inset-0" />
      </div>
      <span
        className={cn(
          "relative flex size-14 items-center justify-center rounded-2xl text-white shadow-lg shadow-indigo-500/30 ring-1 ring-white/10 ring-inset transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:scale-105",
          dragging && "scale-105"
        )}
      >
        <span className="brand-gradient absolute inset-0 rounded-2xl" aria-hidden />
        <UploadCloud className="relative size-6" strokeWidth={1.75} />
      </span>
      <div className="relative">
        <div className="text-[15px] font-semibold text-foreground">Drop a .dwg file here</div>
        <div className="mt-0.5 text-[13px] text-muted-foreground">to convert it into a sharp PNG image</div>
      </div>
      <div className="relative flex flex-col-reverse items-center gap-2.5 sm:flex-row sm:gap-3">
        <span className="rounded-lg border border-border bg-background px-4 py-2 text-[13px] font-semibold text-foreground shadow-sm transition-all group-hover:border-primary/40 group-hover:text-primary">
          Browse files
        </span>
        <span className="text-xs text-muted-foreground">or drag &amp; drop · max {maxMb} MB</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".dwg"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}