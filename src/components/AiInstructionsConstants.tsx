import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Upload, Loader2, FileText, Trash2, Download } from "lucide-react";

const BUCKET = "document-uploads-constant";

interface ConstantSlot {
  key: string;
  label: string;
  variable: string;
}

const SLOTS: ConstantSlot[] = [
  {
    key: "prod-creation-two-pdf",
    label: "Product_Data_Instructions",
    variable: "PROD_CREATION_TWO_PDF",
  },
  {
    key: "prod-creation-datasheet-only",
    label: "Product_Data_Instructions_Datasheet_Only",
    variable: "PROD_CREATION_DATASHEET_ONLY",
  },
  {
    key: "prod-creation-webpage-only",
    label: "Product_Data_Instructions_Webpage_Only",
    variable: "PROD_CREATION_WEBPAGE_ONLY",
  },
  {
    key: "prod-creation-single-pdf",
    label: "Product_Data_Instructions_Single_PDF",
    variable: "PROD_CREATION_SINGLE_PDF",
  },
  {
    key: "technical-ai-prompt-instructions",
    label: "Technical_AI_Prompt_Instructions",
    variable: "TECHNICAL_AI_PROMPT_PDF",
  },
  {
    key: "marketing-ai-prompt-instructions",
    label: "Marketing_AI_Prompt_Instructions",
    variable: "MARKETING_AI_PROMPT_PDF",
  },
  {
    key: "verify-ai-entries-instructions",
    label: "Verify_AI_Entries_Instructions",
    variable: "VERIFY_AI_ENTRIES_PDF",
  },
  {
    key: "ai-compare-datasheets",
    label: "Compare_Two_Data_Sheets_Instructions",
    variable: "AI_COMPARE_DATASHEETS_PDF",
  },
];

interface FileInfo {
  name: string;
  uploadedAt: string;
  path: string;
}

export function AiInstructionsConstants() {
  const { toast } = useToast();
  const [files, setFiles] = useState<Record<string, FileInfo | null>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [removeTarget, setRemoveTarget] = useState<ConstantSlot | null>(null);

  const loadFiles = useCallback(async () => {
    try {
      const result: Record<string, FileInfo | null> = {};
      for (const slot of SLOTS) {
        const { data, error } = await supabase.storage
          .from(BUCKET)
          .list(slot.key, { limit: 1, sortBy: { column: "created_at", order: "desc" } });

        if (error || !data || data.length === 0) {
          result[slot.key] = null;
          continue;
        }

        const file = data[0];
        const filePath = `${slot.key}/${file.name}`;

        result[slot.key] = {
          name: file.name,
          uploadedAt: file.created_at || "",
          path: filePath,
        };
      }
      setFiles(result);
    } catch (e) {
      console.error("Failed to load constant files:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleUpload = async (slot: ConstantSlot, file: File) => {
    setUploading((prev) => ({ ...prev, [slot.key]: true }));
    try {
      const { data: existing } = await supabase.storage
        .from(BUCKET)
        .list(slot.key);

      if (existing && existing.length > 0) {
        const paths = existing.map((f) => `${slot.key}/${f.name}`);
        await supabase.storage.from(BUCKET).remove(paths);
      }

      const filePath = `${slot.key}/${file.name}`;
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(filePath, file, { upsert: true });

      if (error) throw error;

      toast({
        title: "Uploaded",
        description: `${file.name} saved for ${slot.label}`,
      });
      await loadFiles();
    } catch (e) {
      console.error("Upload failed:", e);
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setUploading((prev) => ({ ...prev, [slot.key]: false }));
    }
  };

  const handleConfirmRemove = async () => {
    if (!removeTarget) return;
    const slot = removeTarget;
    setRemoveTarget(null);
    try {
      const { data: existing } = await supabase.storage
        .from(BUCKET)
        .list(slot.key);

      if (existing && existing.length > 0) {
        const paths = existing.map((f) => `${slot.key}/${f.name}`);
        await supabase.storage.from(BUCKET).remove(paths);
      }

      toast({ title: "Removed", description: `${slot.label} file removed.` });
      await loadFiles();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Remove failed",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const formatDate = (iso: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    return (
      d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " " +
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    );
  };

  const handleDownload = async (info: FileInfo) => {
    try {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .download(info.path);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = info.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Download failed",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading constants...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Constant PDF files referenced by AI prompts. These persist in storage and can be used via template variables.
      </p>

      {SLOTS.map((slot) => {
        const info = files[slot.key];
        const isUploading = uploading[slot.key];

        return (
          <div
            key={slot.key}
            className="flex items-center gap-3 flex-wrap rounded-lg border border-border p-3"
          >
            <div className="flex-1 min-w-[200px]">
              <span className="font-semibold text-sm block">{slot.label}</span>
              {info && (
                <div className="flex items-center gap-2 mt-1">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs text-foreground truncate max-w-[200px]">
                    {info.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(info.uploadedAt)}
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleUpload(slot, f);
                    e.target.value = "";
                  }}
                />
                <Button type="button" variant="outline" size="sm" asChild disabled={isUploading}>
                  <span>
                    {isUploading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    ) : (
                      <Upload className="h-3.5 w-3.5 mr-1" />
                    )}
                    {isUploading ? "Uploading..." : "Upload PDF"}
                  </span>
                </Button>
              </label>

              {info && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleDownload(info)}
                    title="Download"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => setRemoveTarget(slot)}
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}

      <AlertDialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove file?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the uploaded file for "{removeTarget?.label}". You can upload a new one at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
