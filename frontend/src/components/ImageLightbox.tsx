"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "cn";

interface ImageLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src?: string | null;
  alt: string;
  title: string;
  subtitle: string;
}

/** Zoom steps, doubling outward from 1x. */
const SCALE_STEPS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8];
const MIN_SCALE = SCALE_STEPS[0]!;
const MAX_SCALE = SCALE_STEPS[SCALE_STEPS.length - 1]!;

/** Wheel zoom is a ratio, so each notch moves a fixed fraction of the current scale. */
const WHEEL_STEP = 0.2;

function nextScale(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    return SCALE_STEPS.find((s) => s > current + 1e-6) ?? MAX_SCALE;
  }
  return [...SCALE_STEPS].reverse().find((s) => s < current - 1e-6) ?? MIN_SCALE;
}

export default function ImageLightbox({
  open,
  onOpenChange,
  src,
  alt,
  title,
  subtitle,
}: ImageLightboxProps) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  // Panning needs a ref: pointermove fires far more often than React re-renders,
  // and routing every event through state makes dragging feel laggy.
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // A new image should start fit-to-window rather than inherit the zoom the user
  // left on the previous one. Keying on `src` during render is the idiomatic way
  // to reset state on a prop change without a setState inside an effect.
  const [shownSrc, setShownSrc] = useState(src);
  if (src !== shownSrc) {
    setShownSrc(src);
    resetView();
  }

  const zoomIn = useCallback(() => setScale((s) => nextScale(s, 1)), []);
  const zoomOut = useCallback(() => setScale((s) => nextScale(s, -1)), []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Leave the browser's own +/- and 0 shortcuts alone inside form fields.
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (e.key === "+" || e.key === "=") {
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        zoomOut();
      } else if (e.key === "0") {
        resetView();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, zoomIn, zoomOut, resetView]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    // Only zoom, never scroll the page, while the pointer is over the image.
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1 + WHEEL_STEP : 1 / (1 + WHEEL_STEP);
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) {
        return;
      }
      setDragging(true);
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: offset.x,
        originY: offset.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [offset.x, offset.y]
  );

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) {
      return;
    }
    setOffset({
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY),
    });
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
      setDragging(false);
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (scale > 1 + 1e-6) {
      resetView();
      return;
    }
    setScale(2);
  }, [scale, resetView]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[85vw] gap-0 overflow-hidden border-border/60 bg-black/95 p-0 text-white sm:max-w-[70vw]">
        <DialogTitle className="sr-only">{title}</DialogTitle>

        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{title}</p>
            <p className="truncate text-xs text-white/60">{subtitle}</p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={zoomOut}
              aria-label="Zoom out"
              className="flex size-8 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Minus className="size-4" />
            </button>
            <button
              type="button"
              onClick={resetView}
              aria-label="Reset zoom"
              className="w-14 rounded-lg px-1 py-1 text-center text-xs tabular-nums text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              {Math.round(scale * 100)}%
            </button>
            <button
              type="button"
              onClick={zoomIn}
              aria-label="Zoom in"
              className="flex size-8 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              onClick={resetView}
              aria-label="Fit to window"
              className="ml-1 flex size-8 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <RotateCcw className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
              className="ml-1 flex size-8 items-center justify-center rounded-lg p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        <div
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          className={cn(
            "flex max-h-[72vh] touch-none items-center justify-center overflow-hidden bg-black p-2 select-none",
            scale > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
          )}
        >
          {src ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={src}
              alt={alt}
              draggable={false}
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
              className="max-h-[62vh] w-auto max-w-full rounded-lg object-contain"
            />
          ) : null}
        </div>

        <p className="border-t border-white/10 px-5 py-2 text-center text-[11px] text-white/50">
          Scroll to zoom · drag to pan · double-click to zoom in
        </p>
      </DialogContent>
    </Dialog>
  );
}
