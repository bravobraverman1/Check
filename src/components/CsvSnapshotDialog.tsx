import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { parseProductCsvImport, type ProductCsvImportResult } from "@/lib/productCsvImport";
import type { PropertyDefinition } from "@/data/defaultProperties";
import { FileText, Upload } from "lucide-react";

type CsvSnapshotPayload = ProductCsvImportResult["jsonPayload"];

type CsvSnapshotSection =
  | "basic"
  | "categories"
  | "aidata"
  | "aidesc"
  | "images"
  | "custom";

interface CsvSnapshotViewerProps {
  properties: PropertyDefinition[];
  externalSnapshot?: CsvSnapshotPayload | null;
  hideUpload?: boolean;
}

const SECTION_OPTIONS: Array<{ value: CsvSnapshotSection; label: string }> = [
  { value: "basic", label: "Basic Info" },
  { value: "categories", label: "Categories" },
  { value: "aidata", label: "AI Data" },
  { value: "aidesc", label: "Title & AI Description" },
  { value: "images", label: "Images" },
  { value: "custom", label: "Filters" },
];

function ReadOnlyField({
  label,
  value,
  multiline = false,
  minHeight,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  minHeight?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {multiline ? (
        <Textarea
          readOnly
          value={value}
          style={minHeight ? { minHeight } : undefined}
          className="resize-none border-border/60 bg-muted/30 text-sm text-foreground font-mono"
        />
      ) : (
        <Input
          readOnly
          value={value}
          className="border-border/60 bg-muted/30 text-sm text-foreground"
        />
      )}
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-[200px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-6 text-center">
      <FileText className="mb-3 h-7 w-7 text-muted-foreground/60" />
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function formatDateTime(value: string): string {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toLocaleString();
}

function normalizeFieldValue(value: unknown): string {
  return String(value ?? "").trim() || "—";
}

/** Strip #N ordinal suffixes for cleaner display names */
function cleanDisplayName(name: string): string {
  return name.replace(/\s*#\s*\d+\s*$/, "").trim();
}

/** Small thumbnail preview for image URLs */
function ImageThumbnail({ src }: { src: string }) {
  const trimmed = String(src ?? "").trim();
  if (!trimmed) return null;

  return (
    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted/30">
      <img
        src={trimmed}
        alt=""
        className="h-full w-full object-cover"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
    </div>
  );
}

export function CsvSnapshotViewer({
  properties,
  externalSnapshot,
  hideUpload = false,
}: CsvSnapshotViewerProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedSection, setSelectedSection] = useState<CsvSnapshotSection>("basic");
  const [snapshot, setSnapshot] = useState<CsvSnapshotPayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (externalSnapshot !== undefined) {
      setSnapshot(externalSnapshot ?? null);
      if (externalSnapshot) setSelectedSection("basic");
    }
  }, [externalSnapshot]);

  /** Build a required-keys lookup from properties */
  const requiredKeys = useMemo(() => {
    const set = new Set<string>();
    for (const prop of properties) {
      if (prop.required) set.add(prop.key);
    }
    return set;
  }, [properties]);

  const handleUpload = async (file: File | null) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast({ variant: "destructive", title: "Invalid file", description: "Choose a CSV file to inspect." });
      return;
    }
    setIsLoading(true);
    try {
      const csvText = await file.text();
      const result = parseProductCsvImport(csvText, { filename: file.name, properties });
      setSnapshot(result.jsonPayload);
      setSelectedSection("basic");
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Could not open CSV",
        description: error instanceof Error ? error.message : "The CSV could not be parsed for viewing.",
      });
    } finally {
      setIsLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  /* ─── Section: Basic Info ─── */
  const renderBasicInfo = () => {
    if (!snapshot) return null;
    return (
      <div className="grid gap-4 md:grid-cols-3">
        <ReadOnlyField label="SKU" value={normalizeFieldValue(snapshot.basicFields.sku)} />
        <ReadOnlyField label="Brand" value={normalizeFieldValue(snapshot.basicFields.brand)} />
        <ReadOnlyField label="Price" value={normalizeFieldValue(snapshot.basicFields.price)} />
        <ReadOnlyField label="Visibility" value={normalizeFieldValue(snapshot.basicFields.visibility)} />
        <ReadOnlyField label="MPN" value={normalizeFieldValue(snapshot.basicFields.gpsMpn)} />
        <div className="md:col-span-3">
          <ReadOnlyField label="Title" value={normalizeFieldValue(snapshot.basicFields.title)} />
        </div>
      </div>
    );
  };

  /* ─── Section: Categories ─── */
  const renderCategories = () => {
    if (!snapshot) return null;
    const mainCat = normalizeFieldValue(snapshot.basicFields.mainCategory);
    const allCats = snapshot.basicFields.selectedCategories;
    const otherCats = allCats.filter((c) => c !== snapshot.basicFields.mainCategory);

    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Main Category
          </Label>
          <div>
            <Badge className="bg-primary text-primary-foreground text-sm font-normal px-3 py-1">
              {mainCat}
            </Badge>
          </div>
        </div>
        {otherCats.length > 0 ? (
          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Additional Categories ({otherCats.length})
            </Label>
            <div className="flex flex-wrap gap-2">
              {otherCats.map((cat, i) => (
                <Badge key={`${cat}-${i}`} variant="secondary" className="text-sm font-normal px-3 py-1">
                  {cat}
                </Badge>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No additional categories assigned.</p>
        )}
      </div>
    );
  };

  /* ─── Section: AI Data ─── */
  const renderAiData = () => {
    if (!snapshot) return null;
    return (
      <ReadOnlyField
        label="AI-Data"
        value={normalizeFieldValue(snapshot.formData.chatgptData)}
        multiline
        minHeight="240px"
      />
    );
  };

  /* ─── Section: Title & AI Description ─── */
  const renderAiDescription = () => {
    if (!snapshot) return null;
    return (
      <div className="grid gap-5">
        <ReadOnlyField
          label="Title"
          value={normalizeFieldValue(snapshot.basicFields.title)}
        />
        <ReadOnlyField
          label="Description"
          value={normalizeFieldValue(snapshot.basicFields.description)}
          multiline
          minHeight="200px"
        />
      </div>
    );
  };

  /* ─── Section: Images ─── */
  const renderImages = () => {
    if (!snapshot) return null;
    if (!snapshot.images.length) {
      return (
        <EmptyState
          title="No images in this CSV"
          description="This snapshot does not include any populated image columns."
        />
      );
    }
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {snapshot.images.map((image) => (
          <div
            key={`${image.slot}-${image.value}`}
            className="flex items-center gap-3 rounded-lg border border-border/60 bg-card p-3"
          >
            <ImageThumbnail src={image.value} />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-foreground">Image {image.slot}</div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground" title={image.value}>
                {image.value}
              </p>
            </div>
          </div>
        ))}
      </div>
    );
  };

  /* ─── Section: Filters ─── */
  const renderFilters = () => {
    if (!snapshot) return null;
    if (!snapshot.customFields.length) {
      return (
        <EmptyState
          title="No filters in this CSV"
          description="This snapshot does not include populated filter fields."
        />
      );
    }

    const renderFieldRow = (field: typeof snapshot.customFields[0]) => {
      const isMapped = !!field.matchedPropertyKey;
      const isRequired = isMapped && requiredKeys.has(field.matchedPropertyKey!);
      const displayName = cleanDisplayName(field.displayName);

      return (
        <div
          key={`${field.displayName}-${field.value}`}
          className="space-y-1"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-foreground">{displayName}</span>
            {isRequired && (
              <span className="text-[11px] font-medium text-destructive">(mandatory)</span>
            )}
            {isMapped && !isRequired && (
              <span className="text-[11px] font-medium text-muted-foreground">(optional)</span>
            )}
            {!isMapped && (
              <span className="text-[11px] font-medium text-muted-foreground">(unmapped)</span>
            )}
          </div>
          <Input
            readOnly
            value={field.value}
            className="h-9 border-border/60 bg-muted/30 text-sm text-foreground"
          />
        </div>
      );
    };

    return (
      <div className="grid gap-4 md:grid-cols-2">
        {snapshot.customFields.map(renderFieldRow)}
      </div>
    );
  };

  /* ─── Section Router ─── */
  const sectionContent = (() => {
    if (!snapshot) {
      return (
        <EmptyState
          title="No CSV snapshot selected"
          description="Open the current uploaded CSV, or choose another CSV to review its fields."
        />
      );
    }
    switch (selectedSection) {
      case "basic": return renderBasicInfo();
      case "categories": return renderCategories();
      case "aidata": return renderAiData();
      case "aidesc": return renderAiDescription();
      case "images": return renderImages();
      case "custom": return renderFilters();
      default: return null;
    }
  })();

  /* ─── Header bar with SKU + MPN always visible ─── */
  const headerBar = snapshot ? (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground truncate">
          {snapshot.filename || "CSV Snapshot"}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {formatDateTime(snapshot.importedAt)}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">SKU</div>
          <div className="text-sm font-semibold text-foreground">{normalizeFieldValue(snapshot.basicFields.sku)}</div>
        </div>
        <div className="h-8 w-px bg-border/60" />
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">MPN</div>
          <div className="text-sm font-semibold text-foreground">{normalizeFieldValue(snapshot.basicFields.gpsMpn)}</div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="space-y-3">
      {!hideUpload && (
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">CSV Preview</h2>
          <div className="flex items-center gap-2">
            {snapshot && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-3 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => setSnapshot(null)}
              >
                Clear
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {isLoading ? "Opening…" : snapshot ? "Replace" : "Upload CSV"}
            </Button>
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => void handleUpload(e.target.files?.[0] ?? null)}
      />

      {/* Section dropdown — only when CSV is loaded */}
      {snapshot && (
        <div className="flex justify-center">
          <div className="w-full max-w-xs">
            <Select value={selectedSection} onValueChange={(v) => setSelectedSection(v as CsvSnapshotSection)}>
              <SelectTrigger className="h-10 border-border bg-card text-sm font-medium">
                <SelectValue placeholder="Section" />
              </SelectTrigger>
              <SelectContent>
                {SECTION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Persistent header with SKU/MPN */}
      {headerBar}

      {/* Section content */}
      <div className="max-h-[68vh] overflow-y-auto rounded-xl bg-muted/20 p-4">
        {sectionContent}
      </div>
    </div>
  );
}
