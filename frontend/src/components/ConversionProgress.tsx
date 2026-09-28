"use client";

import { Check, Loader2, UploadCloud } from "lucide-react";
import { cn } from "cn";

export type ProgressStep = "upload" | "parse" | "render" | "done";

const STEPS = [
  { key: "upload", label: "Upload", icon: UploadCloud },
  { key: "convert", label: "Converting", icon: Loader2 },
  { key: "done", label: "Done", icon: Check },
] as const;

const STATUS: Record<ProgressStep, string> = {
  upload: "Preparing…",
  parse: "Reading DWG geometry…",
  render: "Rendering PNG…",
  done: "Done",
};

interface ConversionProgressProps {
  step: ProgressStep;
  /**
   * Bytes sent to storage so far, 0–1. Only meaningful during the upload step;
   * `null`/omitted means the platform reports no progress (multipart fallback).
   */
  uploadProgress?: number | null;
}

/** Three-step progress stepper shown while the DWG is being converted. */
export default function ConversionProgress({ step, uploadProgress = null }: ConversionProgressProps) {
  const activeIndex = step === "done" ? 2 : step === "parse" || step === "render" ? 1 : 0;
  const showUploadBar = step === "upload" && uploadProgress !== null;

  return (
    <div className="mt-6 animate-fade-in" role="status" aria-live="polite">
      <ol className="flex items-center">
        {STEPS.map((stat, index) => {
          const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
          const Icon = stat.icon;
          return (
            <li
              key={stat.key}
              className={cn("flex flex-1 items-center", index > 0 && "relative")}
              aria-current={index === activeIndex ? "step" : undefined}
            >
              {index > 0 && (
                <span
                  aria-hidden
                  className="absolute top-4 right-[calc(50%+20px)] left-[calc(-50%+20px)] h-0.5 -translate-y-1/2 rounded-full"
                  style={{
                    background: index <= activeIndex ? "var(--primary)" : "var(--border)",
                  }}
                />
              )}
              <div className="relative flex flex-1 flex-col items-center gap-1.5">
                <span
                  className={cn(
                    "relative z-10 flex size-8 items-center justify-center rounded-full border transition-colors",
                    state === "done" && "border-primary bg-primary text-primary-foreground",
                    state === "active" &&
                      "border-transparent bg-linear-to-r from-indigo-500 to-violet-500 text-white shadow-md shadow-indigo-500/30",
                    state === "pending" && "border-border bg-muted text-muted-foreground"
                  )}
                >
                  {state === "active" && (
                    <span aria-hidden className="absolute -inset-1 animate-pulse rounded-full bg-indigo-500/20" />
                  )}
                  {state === "done" ? (
                    <Check className="size-4" />
                  ) : (
                    <Icon className={cn("size-4", state === "active" && "animate-spin")} />
                  )}
                </span>
                <span
                  className={cn(
                    "text-xs font-medium",
                    state === "active" ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {stat.label}
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-muted">
        {showUploadBar ? (
          <div
            className="h-full rounded-full bg-linear-to-r from-indigo-500 to-violet-500 transition-[width] duration-200"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, uploadProgress ?? 0)) * 100)}%` }}
          />
        ) : activeIndex === 1 ? (
          <div className="progress-indeterminate h-full rounded-full bg-linear-to-r from-indigo-500 to-violet-500" />
        ) : (
          <div className="h-full w-full rounded-full bg-linear-to-r from-indigo-500 to-violet-500" />
        )}
      </div>

      <p className="mt-2 text-center text-[13px] font-medium text-muted-foreground">
        {showUploadBar
          ? `Uploading DWG… ${Math.round(Math.min(1, Math.max(0, uploadProgress ?? 0)) * 100)}%`
          : STATUS[step]}
      </p>
    </div>
  );
}
