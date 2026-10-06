"use client";

import { Download, Expand, Check } from "lucide-react";
import { cn } from "cn";

interface ImagePreviewCardProps {
  src: string;
  alt: string;
  imageClassName?: string;
  /** Renders this card as the chosen sheet (primary ring + badge). */
  selected?: boolean;
  /** Marks this sheet as selected when set on the card. */
  onSelect?: () => void;
  onToggleBig: () => void;
  onDownload: () => void;
}

export default function ImagePreviewCard({
  src,
  alt,
  imageClassName,
  selected = false,
  onSelect,
  onToggleBig,
  onDownload,
}: ImagePreviewCardProps) {
  const handlePreviewClick = () => {
    if (onSelect) {
      onSelect();
      return;
    }
    onToggleBig();
  };

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-white shadow-sm transition-shadow duration-300 hover:shadow-lg",
        selected
          ? "border-primary ring-2 ring-primary/50"
          : "border-border/70 ring-0"
      )}
    >
      <button
        type="button"
        onClick={handlePreviewClick}
        aria-label={`View ${alt} larger`}
        className="block w-full cursor-zoom-in"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className={cn(
            "block max-h-[38vh] w-full bg-white object-contain transition-transform duration-300 group-hover:scale-[1.015]",
            imageClassName
          )}
        />
        <span className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-foreground/0 transition group-hover:ring-foreground/10" />
      </button>

      {selected && (
        <span className="pointer-events-none absolute top-2.5 left-2.5 flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[11px] font-semibold text-white shadow-md">
          <Check className="size-3" strokeWidth={3} />
          Selected
        </span>
      )}

      {/* Expand and Download live here. Generation lives in the AI
          visualization section below the grid, operating on the selected sheet. */}
      <div className="absolute right-2.5 bottom-2.5 flex gap-1.5">
        <button
          type="button"
          onClick={onToggleBig}
          aria-label="View larger"
          className="flex size-8 items-center justify-center rounded-lg bg-black/55 text-white shadow-sm backdrop-blur-md transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <Expand className="size-4" />
        </button>
        <button
          type="button"
          onClick={onDownload}
          aria-label="Download"
          className="flex size-8 items-center justify-center rounded-lg bg-black/55 text-white shadow-sm backdrop-blur-md transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <Download className="size-4" />
        </button>
      </div>
    </div>
  );
}
