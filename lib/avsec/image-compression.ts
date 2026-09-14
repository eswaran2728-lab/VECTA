/**
 * Client-side Image Compression Utility for VECTA
 *
 * Compresses images (SEC reports, Leave/MC attachments, ICMS incident photos)
 * before uploading to Supabase Storage or submitting base64 payloads.
 *
 * Target: Under 500KB per image with crisp legibility for compliance documents.
 */

export interface ImageCompressionOptions {
  maxDimension?: number; // Maximum width or height in pixels (default: 1600)
  quality?: number; // Quality setting 0.1 - 1.0 (default: 0.8)
  format?: "image/webp" | "image/jpeg"; // Target MIME type (default: image/webp)
}

const DEFAULT_OPTIONS: Required<ImageCompressionOptions> = {
  maxDimension: 1600,
  quality: 0.8,
  format: "image/webp",
};

/**
 * Compresses an image File or Blob using HTML5 Canvas.
 * Returns a compressed Blob (or the original if compression fails or yields larger size).
 */
export async function compressImage(
  file: File | Blob,
  options?: ImageCompressionOptions
): Promise<Blob> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Skip non-images (e.g. PDFs)
  if (file.type && !file.type.startsWith("image/")) {
    return file;
  }

  try {
    let width = 0;
    let height = 0;
    let imageSource: ImageBitmap | HTMLImageElement;

    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      width = bitmap.width;
      height = bitmap.height;
      imageSource = bitmap;
    } else {
      // Fallback for environments where createImageBitmap is unavailable
      const img = await loadImageElement(file);
      width = img.naturalWidth || img.width;
      height = img.naturalHeight || img.height;
      imageSource = img;
    }

    // Calculate proportional downscale if exceeding maxDimension
    const maxDim = opts.maxDimension;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    // High quality canvas rendering
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(imageSource, 0, 0, targetWidth, targetHeight);

    // Try target format first, fallback to jpeg
    let compressedBlob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, opts.format, opts.quality)
    );

    if (!compressedBlob && opts.format !== "image/jpeg") {
      compressedBlob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", opts.quality)
      );
    }

    // Clean up ImageBitmap if applicable
    if ("close" in imageSource && typeof imageSource.close === "function") {
      imageSource.close();
    }

    // Return compressed blob if smaller, otherwise return original
    if (compressedBlob && compressedBlob.size > 0 && compressedBlob.size < file.size) {
      return compressedBlob;
    }

    return compressedBlob || file;
  } catch (err) {
    console.warn("[compressImage] Client compression skipped:", err);
    return file;
  }
}

/**
 * Compresses a base64 DataURL (used by incident photos and offline queue).
 */
export async function compressImageDataUrl(
  dataUrl: string,
  options?: ImageCompressionOptions
): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!dataUrl.startsWith("data:image/")) {
    return dataUrl;
  }

  try {
    const img = document.createElement("img");
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load image DataURL"));
      img.src = dataUrl;
    });

    const maxDim = opts.maxDimension;
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    const compressedUrl = canvas.toDataURL(opts.format, opts.quality);
    // If WebP is unsupported in canvas toDataURL, canvas falls back to PNG (which might be larger)
    if (compressedUrl.length < dataUrl.length) {
      return compressedUrl;
    }

    // Fallback to JPEG
    const jpegUrl = canvas.toDataURL("image/jpeg", opts.quality);
    return jpegUrl.length < dataUrl.length ? jpegUrl : dataUrl;
  } catch (err) {
    console.warn("[compressImageDataUrl] Compression error:", err);
    return dataUrl;
  }
}

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = document.createElement("img");
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image element"));
    };
    img.src = url;
  });
}
