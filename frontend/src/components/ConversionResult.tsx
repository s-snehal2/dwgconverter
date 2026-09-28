"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

import {
  downloadUrl,
  generateAiImage,
  aiDownloadUrl,
  sendToTilesview,
} from "@/services/api";

import {
  Check,
  Loader2,
  MonitorSmartphone,
  MousePointerClick,
  Sparkles,
  LayoutGrid,
} from "lucide-react";
import type {
  BlankSheetReason,
  ConversionResult as ConversionResultData,
  OmittedSheet,
} from "@/types/conversion";

import { cn } from "cn";
import { Button } from "@/components/ui/button";
import ImagePreviewCard from "@/components/ImagePreviewCard";
import ImageLightbox from "@/components/ImageLightbox";

/** Plain-language label per drop reason, shown in the omission note. */
const OMITTED_REASON_LABEL: Record<BlankSheetReason, string> = {
  "no-drawing": "nothing drawn",
  "too-little-detail": "too little detail",
};

function describeOmitted(sheet: OmittedSheet): string {
  return `${sheet.name} (${OMITTED_REASON_LABEL[sheet.reason]})`;
}

interface ConversionResultProps {
  results: ConversionResultData[];
  omittedBlankSheets?: OmittedSheet[];
  onReset: () => void;
}

export default function ConversionResult({ results, omittedBlankSheets = [], onReset }: ConversionResultProps) {
  const [selectedId, setSelectedId] = useState<string | null>(results[0]?.conversionId ?? null);
  const [generating, setGenerating] = useState(false);
  const [downloadingAi, setDownloadingAi] = useState(false);
  const [sendingToTilesview, setSendingToTilesview] = useState(false);
  const [generatedAi, setGeneratedAi] = useState<Record<string, boolean>>({});
  const [aiUsageById, setAiUsageById] = useState<Record<string, { used: number; limit: number }>>({});
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ kind: "png" | "ai"; id: string } | null>(null);

  const selected = results.find((result) => result.conversionId === selectedId) ?? results[0] ?? null;

  const downloadImageFile = useCallback(
    async (url: string, fileName: string, notAvailable: string) => {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok || !res.headers.get("content-type")?.includes("image/png")) {
        throw new Error(notAvailable);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    },
    []
  );

  const handleDownload = useCallback(
    async (result: ConversionResultData) => {
      if (downloadingId) return;
      setDownloadingId(result.conversionId);
      try {
        await downloadImageFile(
          downloadUrl(result.conversionId),
          result.fileName,
          "Your converted file is no longer available on this server."
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "The PNG could not be downloaded.";
        toast.error(message);
      } finally {
        setDownloadingId(null);
      }
    },
    [downloadingId, downloadImageFile]
  );

  const handleSelect = useCallback((result: ConversionResultData) => {
    setSelectedId(result.conversionId);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!selected || generating) return;
    setGenerating(true);
    const id = selected.conversionId;
    try {
      const res = await generateAiImage(id);
      setAiUsageById((prev) => ({ ...prev, [id]: { used: res.generationsUsed, limit: res.generationsLimit } }));
      setGeneratedAi((prev) => ({ ...prev, [id]: true }));
      toast.success("AI image generated successfully.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI generation failed.";
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  }, [generating, selected]);

  const handleTilesview = useCallback(async () => {
    if (!selected || sendingToTilesview) return;
    setSendingToTilesview(true);
    // Pre-open the tab synchronously inside the click handler so the browser
    // cannot block it as a popup (user activation often expires during the
    // async upload step), then point it at the visualizer once the upload
    // succeeds. The app tab stays open.
    const opener = window.open("", "_blank");
    try {
      const res = await sendToTilesview(selected.conversionId);
      toast.success(`Sent to TilesView. Room ID: ${res.customRoomsId}. Opened in a new tab.`);
      if (opener && !opener.closed) {
        opener.location.href = res.visualizerUrl;
      } else {
        window.open(res.visualizerUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      opener?.close();
      const message = err instanceof Error ? err.message : "Sending to TilesView failed.";
      toast.error(message);
    } finally {
      setSendingToTilesview(false);
    }
  }, [selected, sendingToTilesview]);

  const handleAiDownload = useCallback(async () => {
    if (!selected || downloadingAi) return;
    setDownloadingAi(true);
    try {
      await downloadImageFile(
        aiDownloadUrl(selected.conversionId),
        `${selected.fileName.replace(/\.png$/i, "")}-ai.png`,
        "The AI image is no longer available on this server."
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "The AI image could not be downloaded.";
      toast.error(message);
    } finally {
      setDownloadingAi(false);
    }
  }, [downloadingAi, downloadImageFile, selected]);

  const selectedAiDone = selected ? Boolean(generatedAi[selected.conversionId]) : false;
  const selectedAiUsage = selected ? aiUsageById[selected.conversionId] : undefined;

  const lightboxResult = lightbox
    ? results.find((r) => r.conversionId === lightbox.id) ?? null
    : null;
  const lightboxSrc = lightbox
    ? lightbox.kind === "ai"
      ? aiDownloadUrl(lightbox.id)
      : downloadUrl(lightbox.id)
    : null;
  const lightboxTitle = lightbox?.kind === "ai" ? "AI Image" : "Converted PNG";
  const lightboxSubtitle = lightboxResult
    ? lightbox?.kind === "ai"
      ? `${lightboxResult.fileName.replace(/\.png$/i, "")}-ai.png`
      : lightboxResult.fileName
    : "";

  const selectedWarnings = selected ? Array.from(new Set(selected.warnings ?? [])) : [];
  const selectedSkipped = selected?.statistics?.skippedEntities ?? 0;
  const warningsHeadline =
    selectedSkipped > 0
      ? `${selectedSkipped} unsupported ${selectedSkipped === 1 ? "entity was" : "entities were"} skipped.`
      : `${selectedWarnings.length} ${selectedWarnings.length === 1 ? "warning was" : "warnings were"} generated during conversion.`;

  return (
    <div className="mt-5 animate-slide-up space-y-4">
      <div className="relative flex items-center gap-2.5 overflow-hidden rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3.5 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-emerald-500 to-teal-500 text-white shadow-md shadow-emerald-500/25">
          <Check className="size-4" strokeWidth={2.25} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {results.length > 1
              ? `${results.length} sheets converted`
              : "Your PNG is ready"}
          </p>
          <p className="truncate text-[13px] text-muted-foreground">
            {results[0]?.originalFileName} · click a sheet to view it, then generate its AI visualization
          </p>
          {omittedBlankSheets.length > 0 && (
            <p className="text-[12px] font-medium text-amber-600 dark:text-amber-400">
              {omittedBlankSheets.length} sheet{omittedBlankSheets.length === 1 ? "" : "s"} produced no PNG
              {omittedBlankSheets.length === 1 ? "" : "s"}: 
              {omittedBlankSheets.slice(0, 3).map(describeOmitted).join(", ")}
              {omittedBlankSheets.length > 3 ? "…" : ""}.
            </p>
          )}
        </div>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          Sheets
        </span>
        <span className="h-px flex-1 bg-border/60" />
      </div>

      <div className="grid grid-cols-1 gap-4 items-start sm:grid-cols-2 xl:grid-cols-3">
        {results.map((result, index) => {
          const isSelected = result.conversionId === selected?.conversionId;
          const aiDone = Boolean(generatedAi[result.conversionId]);
          const skipped = result.statistics?.skippedEntities ?? 0;
          const warnings = Array.from(new Set(result.warnings ?? []));
          return (
            <div
              key={result.conversionId}
              className={cn(
                "flex min-w-0 flex-col rounded-2xl border bg-card/50 p-3 transition-colors",
                isSelected ? "border-primary/40 bg-primary/[0.04]" : "border-border/60"
              )}
            >
              <div className="mb-2 flex min-w-0 items-center gap-2 px-1">
                <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                  {result.sheetName ?? `Sheet ${index + 1}`}
                </p>
                {aiDone && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                    <Sparkles className="size-3" />
                    AI ready
                  </span>
                )}
              </div>
              <p className="mb-2 min-w-0 truncate px-1 text-[12px] text-muted-foreground">
                {result.fileName}
                {result.size ? ` · ${(result.size / (1024 * 1024)).toFixed(2)} MB` : ""}
                {skipped > 0 ? ` · ${skipped} skipped` : ""}
                {warnings.length > 0 ? ` · ${warnings.length} warning(s)` : ""}
              </p>

              <ImagePreviewCard
                src={downloadUrl(result.conversionId)}
                alt={`Converted PNG: ${result.fileName}`}
                imageClassName="h-56"
                selected={isSelected}
                onSelect={() => setLightbox({ kind: "png", id: result.conversionId })}
                onToggleBig={() => setLightbox({ kind: "png", id: result.conversionId })}
                onDownload={() => handleDownload(result)}
              />

<div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 rounded-xl text-xs font-semibold"
                    onClick={() => handleSelect(result)}
                  >
                    <MousePointerClick className="size-3.5" />
                    {isSelected ? "Selected" : "Select for AI"}
                  </Button>
                </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-border/40 pt-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            AI visualization
          </span>
          <span className="h-px flex-1 bg-border/60" />
        </div>

        <div className="space-y-2.5">
          {!selected ? (
            <p className="px-1 text-center text-sm text-muted-foreground">
              No sheet selected.
            </p>
          ) : (
            <>
              <div className="rounded-xl border border-border/70 bg-card/60 p-3">
                <p className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                  <Sparkles className="size-3.5 text-amber-500" />
                  “{selected.sheetName ?? selected.fileName}”
                </p>
                <p className="text-xs text-muted-foreground">
                  AI visualization is generated with the standard room styling prompt.
                </p>
              </div>

              {generating ? (
                <div className="flex h-20 items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/60 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Generating AI image…
                </div>
              ) : (
                <Button
                  className="h-10 w-full rounded-xl bg-linear-to-r from-amber-500 to-orange-500 text-sm font-semibold text-white shadow-md shadow-amber-500/25 transition-all hover:from-amber-500 hover:to-orange-600 hover:shadow-amber-500/35 disabled:from-amber-500/60 disabled:to-orange-500/60"
                  onClick={handleGenerate}
                >
                  <Sparkles />
                  {selectedAiDone ? "Regenerate AI image" : "Generate AI image"}
                  {selectedAiUsage ? ` (${selectedAiUsage.used}/${selectedAiUsage.limit})` : ""}
                </Button>
              )}

              {selectedAiUsage && selectedAiUsage.used >= selectedAiUsage.limit && (
                <p className="px-1 text-center text-xs text-muted-foreground">
                  Generation limit reached ({selectedAiUsage.limit}/{selectedAiUsage.limit}) for this sheet.
                  Convert the DWG again to generate more.
                </p>
              )}

              {selectedAiDone && !generating && (
                <div className="animate-slide-up">
                  <ImagePreviewCard
                    src={aiDownloadUrl(selected.conversionId)}
                    alt={`AI visualization: ${selected.fileName}`}
                    imageClassName="h-64"
                    onToggleBig={() => setLightbox({ kind: "ai", id: selected.conversionId })}
                    onDownload={handleAiDownload}
                  />
                  <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                    <Button
                      className="h-11 flex-1 rounded-xl bg-linear-to-r from-indigo-500 to-violet-500 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition-all hover:from-indigo-500 hover:to-violet-600 hover:shadow-indigo-500/40 disabled:from-indigo-500/60 disabled:to-violet-500/60"
                      onClick={handleTilesview}
                      disabled={sendingToTilesview}
                    >
                      {sendingToTilesview ? <Loader2 className="animate-spin" /> : <MonitorSmartphone />}
                      {sendingToTilesview ? "Sending to TilesView…" : "Send to Visualizer"}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {selectedWarnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3.5 py-2.5 text-xs text-amber-700 dark:text-amber-400">
          <p className="font-medium">{warningsHeadline}</p>
          <details className="mt-1.5">
            <summary className="cursor-pointer list-none font-medium underline decoration-dotted underline-offset-4">
              Details ({selectedWarnings.length})
            </summary>
            <ul className="mt-1.5 list-inside list-disc space-y-0.5">
              {selectedWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      <div className="space-y-2">
        <Button
          variant="outline"
          className="w-full h-11 rounded-xl text-sm flex-1"
          onClick={onReset}
        >
          <LayoutGrid />
          Convert another DWG
        </Button>
      </div>

      <ImageLightbox
        open={lightbox !== null}
        onOpenChange={(open) => !open && setLightbox(null)}
        src={lightboxSrc}
        alt={lightbox?.kind === "ai" ? "AI visualization preview" : "Converted PNG preview"}
        title={lightboxTitle}
        subtitle={lightboxSubtitle}
      />
    </div>
  );
}