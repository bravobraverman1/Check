import { invokeEdgeFunction } from "@/lib/edgeAuth";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Types that Cloudinary accepts without transformation charges */
const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Cloudinary domain used to detect uploaded-by-us URLs */
export const CLOUDINARY_DOMAIN = "res.cloudinary.com";

type HeicTools = {
  heicTo: (args: { blob: Blob; type: string; quality?: number }) => Promise<Blob>;
  isHeic: (file: Blob) => Promise<boolean>;
};

let heicToolsPromise: Promise<HeicTools> | null = null;

async function loadHeicTools(): Promise<HeicTools> {
  if (!heicToolsPromise) {
    heicToolsPromise = import("heic-to").then((mod) => ({
      heicTo: mod.heicTo,
      isHeic: mod.isHeic,
    }));
  }
  return heicToolsPromise;
}

export function isCloudinaryUrl(url: string): boolean {
  try {
    return new URL(url).hostname === CLOUDINARY_DOMAIN;
  } catch {
    return false;
  }
}

export interface CloudinaryResult {
  secure_url: string;
  public_id: string;
  original_filename: string;
  bytes: number;
  format: string;
}

interface CloudinarySignUploadResponse {
  success?: boolean;
  cloudName?: string;
  apiKey?: string;
  timestamp?: number;
  signature?: string;
  folder?: string;
  error?: string;
}

/** Convert any image to JPEG client-side before uploading to Cloudinary.
 *  This avoids server-side transformation charges on the free plan. */
async function ensureAcceptedBlob(
  file: File
): Promise<{ blob: Blob; filename: string }> {
  // Already a standard web format — pass through
  if (ACCEPTED_TYPES.has(file.type)) {
    return { blob: file, filename: file.name };
  }

  const baseName = file.name.replace(/\.[^.]+$/, "") + ".jpg";

  // HEIC/HEIF — use heic-to library (WebAssembly-based, reliable)
  let fileIsHeic =
    /\.(heic|heif)$/i.test(file.name) ||
    file.type === "image/heic" ||
    file.type === "image/heif";

  // Only sniff unknown/binary files. This avoids loading HEIC WASM on common non-HEIC uploads.
  if (!fileIsHeic && (!file.type || file.type === "application/octet-stream")) {
    try {
      const { isHeic } = await loadHeicTools();
      fileIsHeic = await isHeic(file);
    } catch {
      fileIsHeic = false;
    }
  }

  if (fileIsHeic) {
    try {
      const { heicTo } = await loadHeicTools();
      const jpegBlob = await heicTo({
        blob: file,
        type: "image/jpeg",
        quality: 0.92,
      });
      return { blob: jpegBlob, filename: baseName };
    } catch (e) {
      console.warn("[cloudinaryUpload] heic-to conversion failed:", e);
      // fall through to canvas fallback
    }
  }

  // TIFF, BMP, AVIF, SVG, and other formats — canvas fallback
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    ctx.drawImage(bitmap, 0, 0);
    const converted = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.92,
    });
    return { blob: converted, filename: baseName };
  } catch {
    throw new Error(
      "This file type is not supported. Please upload JPG, PNG, WebP, GIF, HEIC, TIFF, BMP, or AVIF."
    );
  }
}


/** Log a successful upload to temp_images via edge function (service role) */
async function logUploadToSupabase(result: CloudinaryResult, file: File) {
  try {
    await invokeEdgeFunction("cloudinary-sign-upload", {
      body: {
        action: "log_upload",
        public_id: result.public_id,
        secure_url: result.secure_url,
        original_filename: file.name,
        bytes: result.bytes,
        mime_type: file.type || `image/${result.format}`,
      },
    });
  } catch (err) {
    // Non-blocking — log but don't fail the upload
    console.warn("[cloudinaryUpload] Failed to log to temp_images:", err);
  }
}

export async function uploadToCloudinary(
  file: File,
  onProgress?: (pct: number) => void
): Promise<CloudinaryResult> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`
    );
  }

  const { blob, filename } = await ensureAcceptedBlob(file);
  const { data: signData, error: signError } = await invokeEdgeFunction<CloudinarySignUploadResponse>(
    "cloudinary-sign-upload",
    { body: { action: "sign_upload" } },
  );

  if (signError) {
    throw new Error(signError.message || "Could not get secure Cloudinary upload signature");
  }

  if (!signData?.success || !signData.cloudName || !signData.apiKey || !signData.timestamp || !signData.signature) {
    throw new Error(signData?.error || "Cloudinary upload signing failed");
  }

  const url = `https://api.cloudinary.com/v1_1/${signData.cloudName}/image/upload`;
  const fd = new FormData();
  fd.append("file", blob, filename);
  fd.append("api_key", signData.apiKey);
  fd.append("timestamp", String(signData.timestamp));
  fd.append("signature", signData.signature);
  if (signData.folder) {
    fd.append("folder", signData.folder);
  }

  // Use XMLHttpRequest for progress
  const result = await new Promise<CloudinaryResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          let secureUrl: string = data.secure_url;
          // Ensure URL ends with a valid image extension
          const validExt = /\.(jpe?g|png|gif|webp)($|\?)/i;
          if (!validExt.test(secureUrl)) {
            secureUrl = secureUrl.replace(/\/upload\//, "/upload/f_jpg/");
            if (!secureUrl.endsWith(".jpg")) {
              secureUrl = secureUrl + ".jpg";
            }
          }
          resolve({
            secure_url: secureUrl,
            public_id: data.public_id,
            original_filename: data.original_filename || file.name,
            bytes: data.bytes || file.size,
            format: data.format || "jpg",
          });
        } catch {
          reject(new Error("Invalid response from Cloudinary"));
        }
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(fd);
  });

  // Log to Supabase (non-blocking)
  logUploadToSupabase(result, file);

  return result;
}
