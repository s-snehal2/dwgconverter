"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import ConverterCard from "@/components/ConverterCard";
import type {
  ConversionResult as ConversionResultData,
  OmittedSheet,
} from "@/types/conversion";
import type { ProgressStep } from "@/components/ConversionProgress";
import { convertDwgFile } from "@/services/api";

/**
 * Client-side cap for the file picker. The server enforces its own
 * `MAX_FILE_SIZE_MB` and is the real authority; in practice the platform's
 * request-body limit (~4.5 MB) bites long before this number does.
 */
const FALLBACK_MAX_MB = 80;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [converting, setConverting] = useState(false);
  const [step, setStep] = useState<ProgressStep>("upload");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ConversionResultData[] | null>(null);
  const [omittedBlankSheets, setOmittedBlankSheets] = useState<OmittedSheet[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const maxMb = FALLBACK_MAX_MB;
  const abortRef = useRef<AbortController | null>(null);

  // Async continuations (conversion promise resolution) must not touch React
  // state after the component has unmounted.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const cancelInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const resetFromCancel = useCallback(() => {
    setConverting(false);
    setStep("upload");
    setError(null);
    setResults(null);
    setOmittedBlankSheets([]);
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
      if (candidate.size > maxMb * 1024 * 1024) {
        setError(`File is larger than the ${maxMb}MB limit.`);
        return;
      }
      cancelInFlight();
      setFile(candidate);
      setError(null);
      setResults(null);
      setStep("upload");
    },
    [cancelInFlight, maxMb]
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
      if (!mountedRef.current) {
        return;
      }
      setResults(converted.sheets);
      setOmittedBlankSheets(converted.omittedBlankSheets ?? []);
      setStep("done");
      toast.success(
        converted.sheets.length > 1
          ? `Conversion complete. ${converted.sheets.length} sheets are ready.`
          : "Conversion complete. Your PNG is ready."
      );
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
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
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      if (mountedRef.current) {
        setConverting(false);
        setUploadProgress(null);
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
        omittedBlankSheets={omittedBlankSheets}
        maxMb={maxMb}
        onFile={selectFile}
        onClear={clearFile}
        onConvert={runConversion}
        onCancel={cancelConversion}
        onReset={reset}
      />
    </main>
  );
}
