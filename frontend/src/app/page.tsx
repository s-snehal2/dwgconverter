"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import ConverterCard from "@/components/ConverterCard";
import type { ConversionResult as ConversionResultData } from "@/types/conversion";
import type { ProgressStep } from "@/components/ConversionProgress";
import { convertDwgFile } from "@/services/api";

const MAX_MB = 80;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [converting, setConverting] = useState(false);
  const [step, setStep] = useState<ProgressStep>("upload");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ConversionResultData[] | null>(null);
  const [skippedBlankSheets, setSkippedBlankSheets] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancelInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const resetFromCancel = useCallback(() => {
    setConverting(false);
    setStep("upload");
    setError(null);
    setResults(null);
    setSkippedBlankSheets([]);
    setUploadProgress(null);
  }, []);

  const cancelConversion = useCallback(() => {
    cancelInFlight();
    resetFromCancel();
    toast.info("Conversion cancelled.");
  }, [cancelInFlight, resetFromCancel]);

  const selectFile = useCallback(
    (candidate: File) => {
      if (!candidate.name.toLowerCase().endsWith(".dwg")) {
        setError("Only .dwg files are supported.");
        return;
      }
      if (candidate.size > MAX_MB * 1024 * 1024) {
        setError(`File is larger than the ${MAX_MB}MB limit.`);
        return;
      }
      cancelInFlight();
      setFile(candidate);
      setError(null);
      setResults(null);
      setStep("upload");
    },
    [cancelInFlight]
  );

  const clearFile = useCallback(() => {
    cancelInFlight();
    setFile(null);
    setError(null);
    setResults(null);
    setStep("upload");
  }, [cancelInFlight]);

  const reset = useCallback(() => {
    clearFile();
    setConverting(false);
  }, [clearFile]);

  const runConversion = useCallback(async () => {
    if (!file) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setConverting(true);
    setError(null);
    setResults(null);
    setStep("upload");
    setUploadProgress(0);

    try {
      const converted = await convertDwgFile(file, {
        signal: controller.signal,
        onUploadProgress: (fraction) => {
          setUploadProgress(fraction);
          if (fraction >= 1) {
            setStep("parse");
            setUploadProgress(null);
          }
        },
      });
      setStep("render");
      setResults(converted.sheets);
      setSkippedBlankSheets(converted.skippedBlankSheets ?? []);
      setStep("done");
      toast.success(
        converted.sheets.length > 1
          ? `Conversion complete. ${converted.sheets.length} sheets are ready.`
          : "Conversion complete. Your PNG is ready."
      );
    } catch (err) {
      if (isAbortError(err)) {
        resetFromCancel();
        return;
      }
      const message = err instanceof Error ? err.message : "Conversion failed.";
      setError(message);
      setStep("upload");
      setUploadProgress(null);
      toast.error(message);
    } finally {
      setConverting(false);
      setUploadProgress(null);
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [file, resetFromCancel]);

  return (
    <main className="mx-auto flex w-full max-w-[min(92vw,760px)] flex-1 items-center justify-center overflow-hidden px-1 py-4">
      <ConverterCard
        file={file}
        converting={converting}
        step={step}
        uploadProgress={uploadProgress}
        error={error}
        results={results}
        skippedBlankSheets={skippedBlankSheets}
        maxMb={MAX_MB}
        onFile={selectFile}
        onClear={clearFile}
        onConvert={runConversion}
        onCancel={cancelConversion}
        onReset={reset}
      />
    </main>
  );
}
