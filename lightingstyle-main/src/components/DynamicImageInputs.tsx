import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, AlertCircle, CheckCircle2, Loader2, ImageOff, ArrowUp, ArrowDown, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SUPABASE_FUNCTIONS_URL } from "@/config/publicEnv";
import { uploadToCloudinary, isCloudinaryUrl } from "@/lib/cloudinaryUpload";
import { buildEdgeRequestHeaders } from "@/lib/edgeAuth";

/** Attempt to load image via server-side proxy to bypass CORS/hotlink restrictions */
async function proxyImageUrl(originalUrl: string): Promise<string | null> {
  try {
    const proxyUrl = `${SUPABASE_FUNCTIONS_URL}/image-proxy`;
    const headers = await buildEdgeRequestHeaders({ "Content-Type": "application/json" });
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: originalUrl }),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

interface DynamicImageInputsProps {
  imageUrls: string[];
  onChange: (urls: string[]) => void;
  error?: string;
  onFirstImageValidation?: (valid: boolean, width?: number, height?: number) => void;
}

const MAX_IMAGES = 20;
const MIN_DIMENSION = 700;
const VALID_EXTENSIONS = /\.(jpe?g|png|gif|webp)$/i;
const URL_PATTERN = /^https?:\/\/.+/i;

type ValidationState = "idle" | "loading" | "valid" | "warning" | "error";

interface ImageValidation {
  state: ValidationState;
  message?: string;
  width?: number;
  height?: number;
  proxiedSrc?: string;
}

function useImageValidation(url: string, index: number): ImageValidation {
  const [result, setResult] = useState<ImageValidation>({ state: "idle" });

  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed) {
      setResult({ state: "idle" });
      return;
    }

    if (!URL_PATTERN.test(trimmed)) {
      setResult({ state: "error", message: "URL must start with http:// or https://" });
      return;
    }

    if (!VALID_EXTENSIONS.test(trimmed)) {
      setResult({ state: "error", message: "Must end in .jpg, .jpeg, .png, .gif, or .webp" });
      return;
    }

    setResult({ state: "loading" });
    let cancelled = false;
    let proxiedObjectUrl: string | null = null;

    const img = new Image();

    img.onload = () => {
      if (cancelled) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w < MIN_DIMENSION || h < MIN_DIMENSION) {
        if (index === 0) {
          setResult({ state: "error", message: `Image is ${w}×${h}px — minimum is ${MIN_DIMENSION}×${MIN_DIMENSION}px`, width: w, height: h });
        } else {
        setResult({ state: "warning", message: `Image is ${w}×${h}px — minimum ${MIN_DIMENSION}×${MIN_DIMENSION}px recommended for best quality`, width: w, height: h });
      }
    } else {
        setResult({ state: "valid", width: w, height: h });
      }
    };

    img.onerror = () => {
      if (cancelled) return;
      proxyImageUrl(trimmed).then((proxied) => {
        if (cancelled) return;
        if (proxied) {
          proxiedObjectUrl = proxied;
          const proxyImg = new Image();
          proxyImg.onload = () => {
            if (cancelled) return;
            const w = proxyImg.naturalWidth;
            const h = proxyImg.naturalHeight;
            if (w < MIN_DIMENSION || h < MIN_DIMENSION) {
              if (index === 0) {
                setResult({ state: "error", message: `Image is ${w}×${h}px — minimum is ${MIN_DIMENSION}×${MIN_DIMENSION}px`, width: w, height: h, proxiedSrc: proxied });
              } else {
              setResult({ state: "warning", message: `Image is ${w}×${h}px — minimum ${MIN_DIMENSION}×${MIN_DIMENSION}px recommended for best quality`, width: w, height: h, proxiedSrc: proxied });
              }
            } else {
              setResult({ state: "valid", width: w, height: h, proxiedSrc: proxied });
            }
          };
          proxyImg.onerror = () => {
            if (cancelled) return;
            if (proxiedObjectUrl) {
              URL.revokeObjectURL(proxiedObjectUrl);
              proxiedObjectUrl = null;
            }
            setResult({ state: "valid", message: "Preview unavailable due to host restrictions" });
          };
          proxyImg.src = proxied;
        } else {
          setResult({ state: "valid", message: "Preview unavailable due to host restrictions" });
        }
      });
    };

    img.src = trimmed;

    return () => {
      cancelled = true;
      if (proxiedObjectUrl) {
        URL.revokeObjectURL(proxiedObjectUrl);
      }
    };
  }, [url, index]);

  return result;
}

function ImageField({
  url,
  index,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  onClear,
  canRemove,
  canMoveUp,
  canMoveDown,
  isDuplicate,
  onValidationChange,
}: {
  url: string;
  index: number;
  onChange: (value: string) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onClear: () => void;
  canRemove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  isDuplicate: boolean;
  onValidationChange?: (valid: boolean, width?: number, height?: number) => void;
}) {
  const validation = useImageValidation(url, index);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [wasUploaded, setWasUploaded] = useState(false);

  // Report validation state for first image back to parent
  useEffect(() => {
    if (onValidationChange) {
      const isValid = validation.state !== "error";
      onValidationChange(isValid, validation.width, validation.height);
    }
  }, [validation.state, validation.width, validation.height, onValidationChange]);

  const hasValue = !!url.trim();
  // Detect if this is a Cloudinary URL (uploaded by us)
  const urlIsFromUpload = wasUploaded || isCloudinaryUrl(url);
  // Has a non-empty pasted/manual URL that isn't from upload
  const hasPastedUrl = hasValue && !urlIsFromUpload;

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    setUploadError(null);
    setUploading(true);
    setUploadProgress(0);

    try {
      const result = await uploadToCloudinary(file, (pct) => setUploadProgress(pct));
      onChange(result.secure_url);
      setWasUploaded(true);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [onChange]);

  const handleClear = useCallback(() => {
    setUploadError(null);
    setWasUploaded(false);
    onClear();
  }, [onClear]);

  // Reset wasUploaded if URL is manually changed to something else
  useEffect(() => {
    if (wasUploaded && url.trim() && !isCloudinaryUrl(url)) {
      setWasUploaded(false);
    }
  }, [url, wasUploaded]);

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor={`image-${index}`} className="text-xs font-medium flex items-center gap-1.5 flex-wrap">
            <span>
              Image URL {index + 1}
              {index === 0 && <span className="text-destructive ml-1">*</span>}
            </span>
            {validation.width && validation.height && (
              <span className="text-muted-foreground font-normal">({validation.width} × {validation.height})</span>
            )}
          </Label>
          <div className="relative">
            <Input
              id={`image-${index}`}
              type="url"
              value={url}
              onChange={(e) => {
                onChange(e.target.value);
                if (wasUploaded) setWasUploaded(false);
              }}
              placeholder={
                index === 0
                  ? "https://example.com/image1.jpg (required)"
                  : "https://example.com/image.jpg"
              }
              disabled={uploading}
              className={cn(
                "h-9 text-sm pr-8",
                isDuplicate && "border-destructive",
                !isDuplicate && validation.state === "error" && "border-destructive",
                !isDuplicate && validation.state === "warning" && "border-amber-400",
                !isDuplicate && validation.state === "valid" && url.trim() && "border-success"
              )}
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              {isDuplicate && url.trim() && (
                <AlertCircle className="h-3.5 w-3.5 text-destructive" />
              )}
              {!isDuplicate && validation.state === "loading" && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
              {!isDuplicate && validation.state === "valid" && url.trim() && (
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              )}
              {!isDuplicate && validation.state === "error" && (
                <AlertCircle className="h-3.5 w-3.5 text-destructive" />
              )}
              {!isDuplicate && validation.state === "warning" && (
                <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
              )}
            </div>
          </div>
        </div>
        {canMoveUp && (
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-foreground shrink-0" onClick={onMoveUp} title="Move up">
            <ArrowUp className="h-4 w-4" />
          </Button>
        )}
        {canMoveDown && (
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-foreground shrink-0" onClick={onMoveDown} title="Move down">
            <ArrowDown className="h-4 w-4" />
          </Button>
        )}
        {canRemove && (
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive shrink-0" onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Duplicate warning */}
      {isDuplicate && url.trim() && (
        <p className="text-destructive text-xs flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          Duplicate URL — this image is already used above
        </p>
      )}

      {/* Validation message */}
      {!isDuplicate && validation.state === "error" && validation.message && (
        <p className="text-destructive text-xs flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {validation.message}
        </p>
      )}
      {!isDuplicate && validation.state === "warning" && validation.message && (
        <p className="text-amber-600 dark:text-amber-400 text-xs flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {validation.message}
        </p>
      )}
      {!isDuplicate && validation.state === "valid" && validation.message && !validation.proxiedSrc && (
        <p className="text-muted-foreground text-xs">{validation.message}</p>
      )}

      {/* Upload / Clear buttons — hide upload if pasted non-Cloudinary URL */}
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileSelect}
          disabled={uploading}
        />

        {/* Uploaded state: greyed out button with X to clear */}
        {urlIsFromUpload && hasValue ? (
          <>
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
              <span className="text-xs text-muted-foreground">Uploaded</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground hover:text-destructive"
              onClick={handleClear}
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Clear
            </Button>
          </>
        ) : hasPastedUrl ? (
          /* URL was pasted manually — only show Clear, no Upload */
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground hover:text-destructive"
            onClick={handleClear}
          >
            <X className="h-3.5 w-3.5 mr-1" />
            Clear
          </Button>
        ) : (
          /* Empty field or uploading — show Upload button */
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                Uploading… {uploadProgress}%
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5 mr-1" />
                Upload image
              </>
            )}
          </Button>
        )}
      </div>

      {/* Upload error */}
      {uploadError && (
        <p className="text-destructive text-xs flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {uploadError}
        </p>
      )}

      {/* Image preview */}
      {url.trim() && URL_PATTERN.test(url.trim()) && VALID_EXTENSIONS.test(url.trim()) && (
        <div className="border border-border rounded-lg overflow-hidden bg-muted/30 w-32 h-32 flex items-center justify-center">
          {((validation.state === "valid" || validation.state === "warning") && !validation.message?.includes("Preview unavailable")) || validation.proxiedSrc ? (
            <img
              src={validation.proxiedSrc || url.trim()}
              alt={`Preview ${index + 1}`}
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : validation.state === "loading" ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <div className="flex flex-col items-center gap-1 text-muted-foreground p-2">
              <ImageOff className="h-5 w-5" />
              <span className="text-[10px] text-center leading-tight">
                {validation.state === "error" ? "Invalid" : "No preview"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DynamicImageInputs({ imageUrls, onChange, error, onFirstImageValidation }: DynamicImageInputsProps) {
  const handleChange = useCallback(
    (index: number, value: string) => {
      const next = [...imageUrls];
      next[index] = value;
      onChange(next);
    },
    [imageUrls, onChange]
  );

  const addField = useCallback(() => {
    if (imageUrls.length < MAX_IMAGES) {
      onChange([...imageUrls, ""]);
    }
  }, [imageUrls, onChange]);

  const removeField = useCallback(
    (index: number) => {
      if (index === 0) return;
      onChange(imageUrls.filter((_, i) => i !== index));
    },
    [imageUrls, onChange]
  );

  const moveField = useCallback(
    (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (target < 0 || target >= imageUrls.length) return;
      const next = [...imageUrls];
      [next[index], next[target]] = [next[target], next[index]];
      onChange(next);
    },
    [imageUrls, onChange]
  );

  const duplicateIndices = useMemo(() => {
    const seen = new Map<string, number>();
    const dupes = new Set<number>();
    imageUrls.forEach((u, i) => {
      const trimmed = u.trim().toLowerCase();
      if (!trimmed) return;
      if (seen.has(trimmed)) {
        dupes.add(i);
      } else {
        seen.set(trimmed, i);
      }
    });
    return dupes;
  }, [imageUrls]);

  return (
    <div className="space-y-4">
      {imageUrls.map((url, index) => (
        <ImageField
          key={index}
          url={url}
          index={index}
          onChange={(v) => handleChange(index, v)}
          onRemove={() => removeField(index)}
          onMoveUp={() => moveField(index, -1)}
          onMoveDown={() => moveField(index, 1)}
          onClear={() => handleChange(index, "")}
          canRemove={index > 0}
          canMoveUp={index > 0}
          canMoveDown={index < imageUrls.length - 1}
          isDuplicate={duplicateIndices.has(index)}
          onValidationChange={index === 0 ? onFirstImageValidation : undefined}
        />
      ))}

      {imageUrls.length < MAX_IMAGES && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={addField}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add another image
        </Button>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
