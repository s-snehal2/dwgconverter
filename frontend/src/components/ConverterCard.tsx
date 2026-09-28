"use client";

import type { ConversionResult as ConversionResultData } from "@/types/conversion";
import { Button } from "@/components/ui/button";
import DwgUploader from "@/components/DwgUploader";
import ConversionProgress, { type ProgressStep } from "@/components/ConversionProgress";
import ConversionResult from "@/components/ConversionResult";
import ErrorMessage from "@/components/ErrorMessage";
import { RotateCcw } from "lucide-react";

interface ConverterCardProps {
  file: File | null;
  converting: boolean;
  step: ProgressStep;
  uploadProgress?: number | null;
  error: string | null;
  results: ConversionResultData[] | null;
  skippedBlankSheets?: string[];
  maxMb: number;
  onFile: (file: File) => void;
  onClear: () => void;
  onConvert: () => void;
  onCancel: () => void;
  onReset: () => void;
}

export default function ConverterCard({
  file,
  converting,
  step,
  uploadProgress,
  error,
  results,
  skippedBlankSheets,
  maxMb,
  onFile,
  onClear,
  onConvert,
  onCancel,
  onReset,
}: ConverterCardProps) {
  return (
    <div className="relative w-full animate-slide-up flex flex-col overflow-hidden rounded-3xl border border-border/60 bg-card/85 shadow-[0_24px_80px_-32px_rgba(79,70,229,0.35)] backdrop-blur-xl">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-indigo-500/50 to-transparent" />
      <div aria-hidden className="pointer-events-none absolute -top-28 -right-24 size-60 animate-float-glow rounded-full bg-linear-to-br from-indigo-400/25 to-violet-400/25 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-24 size-60 rounded-full bg-linear-to-br from-violet-400/15 to-indigo-400/15 blur-3xl" />

      <div className="relative shrink-0 px-6 pt-6 sm:px-8 sm:pt-7">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/15 bg-primary/5 px-3 py-1 font-mono text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
          <span className="size-1.5 rounded-full bg-primary" />
          DWG → PNG
        </span>
      </div>

      <div className="no-scrollbar relative flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-5 sm:px-8 sm:pb-7">
        <DwgUploader
          file={file}
          onFile={onFile}
          onClear={onClear}
          disabled={converting}
          maxMb={maxMb}
        />

        {converting && <ConversionProgress step={step} uploadProgress={uploadProgress} />}
        {error && !converting && <ErrorMessage message={error} />}

        {!results && !converting && (
          <div className="mt-5 flex items-center gap-3">
            <Button
              size="lg"
              className="h-12 flex-1 rounded-xl bg-linear-to-r from-indigo-500 to-violet-500 text-[15px] font-semibold text-white shadow-lg shadow-indigo-500/30 transition-all hover:from-indigo-500 hover:to-violet-600 hover:shadow-indigo-500/40 disabled:from-indigo-500/60 disabled:to-violet-500/60"
              disabled={!file}
              onClick={onConvert}
            >
              Convert to PNG
            </Button>
          </div>
        )}

        {converting && (
          <div className="mt-5 flex items-center gap-3">
            <Button
              size="lg"
              variant="outline"
              className="h-12 flex-1 rounded-xl text-[15px] font-semibold"
              onClick={onReset}
            >
              <RotateCcw />
              Convert another
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-12 flex-1 rounded-xl border-destructive/30 text-[15px] font-semibold text-destructive hover:bg-destructive/10"
              onClick={onCancel}
            >
              Cancel
            </Button>
          </div>
        )}

        {results && results.length > 0 && (
          <ConversionResult
            results={results}
            skippedBlankSheets={skippedBlankSheets}
            onReset={onReset}
          />
        )}
      </div>
    </div>
  );
}
