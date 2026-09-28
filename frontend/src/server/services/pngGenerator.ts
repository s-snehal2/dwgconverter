import sharp from "sharp";

/** Optional target output size; the SVG may be supersampled above this. */
export interface PngTarget {
  maxWidth: number;
  maxHeight: number;
}

/**
 * Rasterize a renderer SVG into a PNG buffer. The SVG is emitted at the final
 * pixel dimensions (or, when supersampled, a multiple of them), so the only
 * resize here is the anti-aliasing downsample back to the target size.
 * Supersampling keeps hairlines thin and crisp; no unsharp mask is applied so
 * the output stays true to the source drawing's line weights.
 */
export async function generatePng(svg: string, target?: PngTarget): Promise<Buffer> {
  let pipeline = sharp(Buffer.from(svg)).flatten({ background: "#ffffff" });

  if (target) {
    pipeline = pipeline.resize({
      width: target.maxWidth,
      height: target.maxHeight,
      fit: "inside",
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: true,
    });
  }

  return pipeline.png({ compressionLevel: 4 }).toBuffer();
}

/**
 * Convert the ink coverage of a rendered PNG into a fraction, used to tell
 * drawing sheets apart from near-blank sheets (title-block frame only). The
 * raster is downscaled to ~512px wide first so the scan stays cheap while the
 * ratio stays representative of the full-res ink.
 */
export async function rasterInkFraction(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png)
    .resize({ width: 512, withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < 128) dark++;
  }
  return dark / (info.width * info.height);
}