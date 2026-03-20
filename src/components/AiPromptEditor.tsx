import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edgeAuth";
import { Loader2, CheckCircle2, Upload, FileText, Trash2, Download, Plus, X } from "lucide-react";
import {
  getCachedPromptVersions,
  getPromptVersions,
  invalidatePromptCaches,
} from "@/lib/aiPromptCache";

const INSTRUCTION_BUCKET = "document-uploads-constant";

interface AIPromptRow {
  id: string;
  version: number;
  description: string;
  content: string;
  created_at: string;
  is_active: boolean;
}

interface AiPromptEditorProps {
  heading: string;
  promptType: string;
  hideHeading?: boolean;
}

/**
 * State machine for the editor buttons:
 *
 * A) content === activeVersion.content
 *    → [✓ This is the Active Prompt (disabled)]  [Save (saves a copy without activating)]
 *
 * B) content === some NON-active saved version's content
 *    → [Activate Version X]  [Save]
 *
 * C) content is completely new (not matching any saved version)
 *    → [Save & Set Active]  [Save (without activating)]
 *
 * Dropdown: selecting a version IMMEDIATELY loads its content into the editor.
 * Below dropdown: "Remove Version X" shown for selected version (guarded).
 */
// Keywords to highlight in the prompt editor
const HIGHLIGHT_KEYWORDS = [
  "AI Product Creation Manual #1",
  "AI Product Creation Manual #2",
  "AI Compare Datasheets",
  "Supplier Datasheet",
  "Supplier Website",
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlightedPrompt(text: string, definedVarNames: string[]): Array<string | JSX.Element> {
  const tokenPatterns = [
    ...HIGHLIGHT_KEYWORDS.map(escapeRegex),
    ...definedVarNames.map((name) => `\\{\\{${escapeRegex(name)}\\}\\}`),
  ];

  const textWithSentinel = `${text}\n `;
  if (tokenPatterns.length === 0) {
    return [textWithSentinel];
  }

  const combined = new RegExp(`(${tokenPatterns.join("|")})`, "g");
  const nodes: Array<string | JSX.Element> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = combined.exec(textWithSentinel)) !== null) {
    const token = match[0];
    const start = match.index;

    if (start > lastIndex) {
      nodes.push(textWithSentinel.slice(lastIndex, start));
    }

    const isVariable = token.startsWith("{{") && token.endsWith("}}");
    nodes.push(
      <mark
        key={`hl-${key++}`}
        style={
          isVariable
            ? { background: "hsl(var(--primary) / 0.18)", color: "hsl(var(--primary))", borderRadius: 3 }
            : { background: "hsl(var(--muted))", color: "hsl(var(--foreground))", borderRadius: 3, fontFamily: "inherit" }
        }
      >
        {token}
      </mark>
    );
    lastIndex = start + token.length;
  }

  if (lastIndex < textWithSentinel.length) {
    nodes.push(textWithSentinel.slice(lastIndex));
  }

  return nodes;
}

export function AiPromptEditor({ heading, promptType, hideHeading = false }: AiPromptEditorProps) {
  const { toast } = useToast();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const [versions, setVersions] = useState<AIPromptRow[]>([]);
  const [content, setContent] = useState("");
  const [description, setDescription] = useState("");
  // Tracks which version is selected in the dropdown (by version number string)
  const [selectedVersionNum, setSelectedVersionNum] = useState<number | null>(null);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);

  // ─── Per-prompt instruction PDF ──────────────────────────────────────────
  const pdfFolder = `prompt-${promptType}`;
  const [pdfInfo, setPdfInfo] = useState<{ name: string; path: string; uploadedAt: string } | null>(null);
  const [pdfUploading, setPdfUploading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(true);

  const loadPdf = useCallback(async () => {
    try {
      const { data, error } = await supabase.storage
        .from(INSTRUCTION_BUCKET)
        .list(pdfFolder, { limit: 1, sortBy: { column: "created_at", order: "desc" } });
      if (error || !data || data.length === 0) {
        setPdfInfo(null);
      } else {
        const f = data[0];
        setPdfInfo({ name: f.name, path: `${pdfFolder}/${f.name}`, uploadedAt: f.created_at || "" });
      }
    } catch (e) {
      console.error("Failed to load instruction PDF:", e);
    } finally {
      setPdfLoading(false);
    }
  }, [pdfFolder]);

  useEffect(() => { loadPdf(); }, [loadPdf]);

  const handlePdfUpload = async (file: File) => {
    setPdfUploading(true);
    try {
      // Remove existing files in folder
      const { data: existing } = await supabase.storage.from(INSTRUCTION_BUCKET).list(pdfFolder);
      if (existing && existing.length > 0) {
        await supabase.storage.from(INSTRUCTION_BUCKET).remove(existing.map(f => `${pdfFolder}/${f.name}`));
      }
      const { error } = await supabase.storage.from(INSTRUCTION_BUCKET).upload(`${pdfFolder}/${file.name}`, file, { upsert: true });
      if (error) throw error;
      toast({ title: "Uploaded", description: `${file.name} saved as instruction PDF for this prompt.` });
      await loadPdf();
    } catch (e) {
      toast({ variant: "destructive", title: "Upload failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setPdfUploading(false);
    }
  };

  const handlePdfRemove = async () => {
    try {
      const { data: existing } = await supabase.storage.from(INSTRUCTION_BUCKET).list(pdfFolder);
      if (existing && existing.length > 0) {
        await supabase.storage.from(INSTRUCTION_BUCKET).remove(existing.map(f => `${pdfFolder}/${f.name}`));
      }
      toast({ title: "Removed", description: "Instruction PDF removed." });
      await loadPdf();
    } catch (e) {
      toast({ variant: "destructive", title: "Remove failed", description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handlePdfDownload = async () => {
    if (!pdfInfo) return;
    try {
      const { data, error } = await supabase.storage.from(INSTRUCTION_BUCKET).download(pdfInfo.path);
      if (error) throw error;
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url; a.download = pdfInfo.name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      toast({ variant: "destructive", title: "Download failed", description: e instanceof Error ? e.message : String(e) });
    }
  };

  // Migrate old binding type names to new strict enum values
  const migrateBindingType = (bt: string): string => {
    const map: Record<string, string> = {
      datasheet_pdf: "supplier_datasheet_pdf",
      website_pdf: "supplier_website_pdf",
      form_data: "form_data_text",
      additional_instructions: "additional_instructions_data",
      edited_ai_data: "form_ai_data_edited",
    };
    return map[bt] || bt;
  };

  // ─── Per-prompt variables (name + description + binding type + required) ─
  interface EditorPromptVariable {
    name: string;
    description: string;
    bindingType: string;
    required?: boolean; // default true
  }

  const EDITOR_BINDING_GROUPS = [
    {
      group: "📄 File Attachments",
      items: [
        { value: "instruction_pdf",             label: "Instruction PDF",              hint: pdfInfo ? `Attached: ${pdfInfo.name}` : "No PDF uploaded for this prompt" },
        { value: "supplier_datasheet_pdf",      label: "Supplier Datasheet PDF (Form)", hint: "The supplier datasheet PDF uploaded on the Form tab" },
        { value: "supplier_website_pdf",        label: "Supplier Website PDF (Form)",  hint: "The supplier website PDF uploaded on the Form tab" },
        { value: "admin_create_description_datasheet_pdf", label: "Admin Create Description Datasheet PDF", hint: "The datasheet PDF uploaded in Admin → Create Description" },
        { value: "compare_supplier_pdf",        label: "Compare: Supplier Datasheet",  hint: "The supplier datasheet uploaded in the Compare Two Datasheets section" },
        { value: "compare_ls_pdf",              label: "Compare: LS Datasheet",        hint: "The LS datasheet uploaded in the Compare Two Datasheets section" },
      ],
    },
    {
      group: "🆔 Product Identity",
      items: [
        { value: "form_sku",                    label: "SKU (selected)",               hint: "The SKU currently selected in the SKU dropdown on the Form tab" },
        ...(promptType === "compare_sheets"
          ? [{
              value: "compare_optional_sku",
              label: "Compare SKU (optional)",
              hint: "The optional SKU entered next to the AI Compare button (for multi-SKU datasheets)",
            }]
          : []),
        { value: "form_brand",                  label: "Brand",                        hint: "The Brand field on the Form tab" },
        { value: "form_title",                  label: "Title",                        hint: "The Title field on the Form tab" },
        { value: "form_description",            label: "Description",                  hint: "The Description field on the Form tab" },
        { value: "form_main_category",          label: "Main Category (path)",         hint: "The full category path selected in the category tree on the Form tab" },
        { value: "form_selected_categories",    label: "All Selected Categories",      hint: "All categories ticked in the category tree on the Form tab" },
      ],
    },
    {
      group: "📝 Product Data",
      items: [
        { value: "form_ai_data_edited",         label: "AI Data (edited)",             hint: "The AI Data textarea on the Form tab, including any manual edits" },
        { value: "form_data_text",              label: "Form Data (all fields)",       hint: "A snapshot of all current field values from the Form tab combined as text" },
        { value: "form_specifications_summary", label: "Specifications / Filters",     hint: "All filled specification and filter fields as 'Attribute: Value' lines" },
        { value: "form_image_urls",             label: "Image URLs",                   hint: "All image URLs entered in the Image URLs section on the Form tab" },
        { value: "form_email_notes",            label: "Email Notes",                  hint: "The Email Notes textarea on the Form tab" },
        { value: "form_filter_context",         label: "Filter Context",               hint: "Auto-generated list of available filters and their allowed values for the selected category" },
      ],
    },
    {
      group: "📋 Instructions",
      items: [
        { value: "additional_instructions_data", label: "Additional Instructions (Data)", hint: "Free-text notes entered below the Generate Data button on the Form tab" },
        { value: "additional_instructions_title",label: "Additional Instructions (Title)", hint: "Free-text notes entered below the Generate Title button on the Form tab" },
        { value: "admin_fitting_type",           label: "Admin Fitting Type", hint: "Fitting Type field in Admin → Create Description" },
      ],
    },
    {
      group: "🏷️ Naming & Categories",
      items: [
        { value: "category_name_structure",     label: "Main Category — Name Structure", hint: "Name Structure column from the Categories tab in Google Sheets" },
        { value: "category_name_example",       label: "Main Category — Name Example",   hint: "Name Example column from the Categories tab in Google Sheets" },
      ],
    },
    {
      group: "✏️ Other",
      items: [
        { value: "custom_text",                 label: "Custom / Static text",         hint: "Resolves to nothing — use for labels or placeholders in prompt text" },
      ],
    },
  ];

  const [variables, setVariables] = useState<EditorPromptVariable[]>([]);
  const [newVarName, setNewVarName] = useState("");
  const [variablesLoading, setVariablesLoading] = useState(true);
  const [autoOpenVarName, setAutoOpenVarName] = useState<string | null>(null);

  const varStorageKey = `ai-prompt-vars-${promptType}`;

  // Load variables from edge function (source of truth), fall back to localStorage
  useEffect(() => {
    let cancelled = false;

    const applyLocalStorageFallback = () => {
      if (cancelled) return;
      try {
        const stored = localStorage.getItem(varStorageKey);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "string") {
            const migrated: EditorPromptVariable[] = parsed.map((n: string) => ({ name: n, description: "", bindingType: "custom_text", required: true }));
            setVariables(migrated);
          } else {
            const migrated = (parsed as EditorPromptVariable[]).map((v: EditorPromptVariable) => ({
              ...v,
              required: v.required !== undefined ? v.required : true,
              bindingType: migrateBindingType(v.bindingType),
            }));
            setVariables(migrated);
          }
        }
      } catch { /* ignore */ }
      setVariablesLoading(false);
    };

    const attemptLoadVars = async (retries = 2): Promise<boolean> => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (cancelled) return false;
        try {
          const { data, error } = await invokeEdgeFunction("manage-ai-prompt", {
            body: { action: "load_vars", promptType },
          });
          const d = data as Record<string, unknown> | null;
          if (!cancelled && !error && d?.variables && Array.isArray(d.variables) && (d.variables as unknown[]).length > 0) {
            const migrated = (d.variables as EditorPromptVariable[]).map((v) => ({
              ...v,
              required: v.required !== undefined ? v.required : true,
              bindingType: migrateBindingType(v.bindingType),
            }));
            setVariables(migrated);
            localStorage.setItem(varStorageKey, JSON.stringify(migrated));
            setVariablesLoading(false);
            return true;
          }
          if (!error) break; // No error but no variables — don't retry
        } catch (e) {
          const isAbort = e instanceof Error && e.name === "AbortError";
          if (isAbort && attempt < retries) {
            // Wait briefly then retry — StrictMode unmount causes abort on first mount
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          console.warn("[AiPromptEditor] load_vars failed, falling back to localStorage:", e);
        }
      }
      return false;
    };

    (async () => {
      const loaded = await attemptLoadVars();
      if (!loaded) applyLocalStorageFallback();
    })();
    return () => { cancelled = true; };
  }, [varStorageKey, promptType]);

  const saveVariables = (vars: EditorPromptVariable[]) => {
    setVariables(vars);
    // Persist to localStorage (fast cache)
    localStorage.setItem(varStorageKey, JSON.stringify(vars));
    // Persist to Supabase via edge function (service-role, bypasses RLS)
    invokeEdgeFunction("manage-ai-prompt", {
      body: { action: "save_vars", promptType, variables: vars },
    }).then(({ error }) => {
      if (error) console.warn(`[AiPromptEditor] save_vars failed for "${promptType}":`, error);
    });
  };

  const addVariable = () => {
    const name = newVarName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!name || variables.some(v => v.name === name)) return;
    saveVariables([...variables, { name, description: "", bindingType: "", required: true }]);
    setNewVarName("");
    // Auto-open the dropdown for the newly added variable
    setTimeout(() => setAutoOpenVarName(name), 50);
  };

  const updateVariable = (idx: number, patch: Partial<EditorPromptVariable>) => {
    const updated = [...variables];
    updated[idx] = { ...updated[idx], ...patch };
    saveVariables(updated);
  };

  const removeVariable = (name: string) => saveVariables(variables.filter(v => v.name !== name));

  // ─── Data fetching ────────────────────────────────────────────────────────

  const fetchVersions = useCallback(async (resetEditorToActive = false) => {
    const applyRows = (rows: AIPromptRow[]) => {
      setVersions(rows);
      if (resetEditorToActive) {
        const active = rows.find((v) => v.is_active);
        if (active) {
          setContent(active.content);
          setDescription("");
          setSelectedVersionNum(active.version);
        }
      }
    };

    try {
      const cachedRows = getCachedPromptVersions(promptType) as AIPromptRow[] | null;
      if (cachedRows && cachedRows.length > 0) {
        applyRows(cachedRows);
        setLoading(false);
      }

      // Retry up to 2 times on AbortError (React StrictMode double-mount)
      let rows: AIPromptRow[] | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rows = (await getPromptVersions(promptType)) as AIPromptRow[];
          break;
        } catch (retryErr) {
          const isAbort = retryErr instanceof Error && retryErr.name === "AbortError";
          if (isAbort && attempt < 2) {
            invalidatePromptCaches(promptType);
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          throw retryErr;
        }
      }
      if (rows) applyRows(rows);
    } catch (e) {
      console.error("Failed to fetch AI prompt versions:", e);
      const fallbackRows = (getCachedPromptVersions(promptType) as AIPromptRow[] | null) ?? [];
      if (fallbackRows.length > 0) {
        applyRows(fallbackRows);
      } else {
        toast({ variant: "destructive", title: "Failed to load AI prompt versions" });
      }
    } finally {
      setLoading(false);
    }
  }, [toast, promptType]);

  useEffect(() => {
    fetchVersions(true);
  }, [fetchVersions]);

  // ─── Derived state ────────────────────────────────────────────────────────

  const activeVersion = useMemo(() => versions.find((v) => v.is_active) ?? null, [versions]);

  /** The version whose content exactly matches what's in the editor right now */
  const matchedVersion = useMemo(
    () => versions.find((v) => v.content === content) ?? null,
    [versions, content]
  );

  /** true when editor content == active version's content */
  const isActiveContent = useMemo(
    () => !!(activeVersion && activeVersion.content === content),
    [activeVersion, content]
  );

  /** The version currently selected in the dropdown */
  const selectedEntry = useMemo(
    () => (selectedVersionNum != null ? (versions.find((v) => v.version === selectedVersionNum) ?? null) : null),
    [selectedVersionNum, versions]
  );

  // ─── Handlers ─────────────────────────────────────────────────────────────

  /** Called when the user picks a version from the dropdown — loads it immediately */
  const handleVersionSelect = useCallback((val: string) => {
    if (val === "__clear__") {
      // Reset back to the active version
      if (activeVersion) {
        setSelectedVersionNum(activeVersion.version);
        setContent(activeVersion.content);
        setDescription("");
      } else {
        setSelectedVersionNum(null);
      }
      return;
    }
    const num = Number(val);
    const entry = versions.find((v) => v.version === num);
    if (entry) {
      setSelectedVersionNum(num);
      setContent(entry.content);
      setDescription("");
    }
  }, [versions, activeVersion]);

  /** Activate an already-saved version (Case B) */
  const handleActivateExisting = useCallback(async () => {
    if (!matchedVersion) return;
    setActivating(true);
    try {
      const { error } = await invokeEdgeFunction("manage-ai-prompt", {
        body: { action: "activate", activateVersion: matchedVersion.version, promptType },
      });
      if (error) throw error;
      invalidatePromptCaches(promptType);
      toast({ title: "Active Prompt Set", description: `Version ${matchedVersion.version} is now the active prompt.` });
      setSelectedVersionNum(matchedVersion.version);
      await fetchVersions(false);
    } catch (e) {
      toast({ variant: "destructive", title: "Failed to activate", description: String(e) });
    } finally {
      setActivating(false);
    }
  }, [matchedVersion, toast, fetchVersions]);

  /** Save new content and also activate it (Case C — "Save & Set Active") */
  const handleSaveAndActivate = useCallback(async () => {
    if (!content.trim()) {
      toast({ variant: "destructive", title: "Prompt content cannot be empty" });
      return;
    }
    setActivating(true);
    try {
      const { data: saveData, error: saveError } = await invokeEdgeFunction("manage-ai-prompt", {
        body: { action: "save", description: description.trim() || undefined, content, promptType },
      });
      if (saveError) throw saveError;
      const newVersion: number = (saveData as Record<string, unknown> | null)?.version as number;
      if (newVersion) {
        const { error: activateError } = await invokeEdgeFunction("manage-ai-prompt", {
          body: { action: "activate", activateVersion: newVersion, promptType },
        });
        if (activateError) throw activateError;
        setSelectedVersionNum(newVersion);
      }
      invalidatePromptCaches(promptType);
      toast({ title: "Saved & Set Active", description: `Version ${newVersion} saved and is now the active prompt.` });
      setDescription("");
      await fetchVersions(false);
    } catch (e) {
      toast({ variant: "destructive", title: "Failed to save & activate", description: String(e) });
    } finally {
      setActivating(false);
    }
  }, [content, description, toast, fetchVersions]);

  /** Save content as a new version WITHOUT activating, then restore editor to active prompt */
  const handleSaveOnly = useCallback(async () => {
    if (!content.trim()) {
      toast({ variant: "destructive", title: "Prompt content cannot be empty" });
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await invokeEdgeFunction("manage-ai-prompt", {
        body: { action: "save", description: description.trim() || undefined, content, promptType },
      });
      if (error) throw error;
      invalidatePromptCaches(promptType);
      toast({ title: (data as Record<string, unknown> | null)?.message as string || "Saved" });
      setDescription("");
      setSelectedVersionNum(null);
      // Reload versions and reset editor back to the currently active prompt
      await fetchVersions(true);
    } catch (e) {
      toast({ variant: "destructive", title: "Failed to save", description: String(e) });
    } finally {
      setSaving(false);
    }
  }, [content, description, toast, fetchVersions]);

  /** Remove the selected version; if it was active, auto-activate the next highest remaining version */
  const handleConfirmRemove = useCallback(async () => {
    if (!selectedEntry) return;
    const wasActive = selectedEntry.is_active;
    setConfirmRemoveOpen(false);
    setSaving(true);
    try {
      const { error } = await invokeEdgeFunction("manage-ai-prompt", {
        body: { action: "remove", selectedVersion: selectedEntry.version, promptType },
      });
      if (error) throw error;

      // If the deleted version was active, activate the next best remaining version
      if (wasActive) {
        const remaining = versions.filter((v) => v.version !== selectedEntry.version);
        if (remaining.length > 0) {
          // Pick the highest version number
          const next = remaining.reduce((best, v) => (v.version > best.version ? v : best), remaining[0]);
          await invokeEdgeFunction("manage-ai-prompt", {
            body: { action: "activate", activateVersion: next.version, promptType },
          });
        }
      }

      invalidatePromptCaches(promptType);
      toast({ title: `Version ${selectedEntry.version} removed` });
      setSelectedVersionNum(null);
      await fetchVersions(true);
    } catch (e) {
      toast({ variant: "destructive", title: "Failed to remove version", description: String(e) });
    } finally {
      setSaving(false);
    }
  }, [selectedEntry, versions, toast, fetchVersions]);

  // ─── Remove guard logic ───────────────────────────────────────────────────

  /**
   * Allow removing any version. The only restriction is cosmetic — we warn
   * if there are no other versions left (removing the last one leaves nothing).
   */
  const canRemoveSelected = useMemo(() => !!selectedEntry, [selectedEntry]);

  const removeBlockedReason = useMemo(() => null, []);

  // ─── Formatting ──────────────────────────────────────────────────────────

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return (
      d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " " +
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading AI prompts…</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!hideHeading && <h4 className="font-bold text-sm">{heading}</h4>}

      {/* ── Per-prompt Instruction PDF ── */}
      <div className="rounded-md border border-border p-3 bg-muted/30">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-xs font-semibold shrink-0">Instruction PDF</span>
            {pdfLoading ? (
              <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</span>
            ) : pdfInfo ? (
              <span className="text-xs text-muted-foreground truncate max-w-[200px]">{pdfInfo.name}</span>
            ) : (
              <span className="text-xs text-muted-foreground italic">No file uploaded</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {!pdfLoading && pdfInfo && (
              <>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={handlePdfDownload} title="Download"><Download className="h-3.5 w-3.5" /></Button>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={handlePdfRemove} title="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
              </>
            )}
            {!pdfLoading && (
              <label className="cursor-pointer">
                <input type="file" accept=".pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePdfUpload(f); e.target.value = ""; }} />
                <Button type="button" variant="outline" size="sm" asChild disabled={pdfUploading}>
                  <span>{pdfUploading ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Uploading…</> : pdfInfo ? "Replace" : <><Upload className="h-3.5 w-3.5 mr-1.5" />Upload</>}</span>
                </Button>
              </label>
            )}
          </div>
        </div>
      </div>

      {/* ── Per-prompt Variable Names ── */}
      <div className="rounded-md border border-border p-4 space-y-3 bg-muted/30">
        <div>
          <span className="text-xs font-semibold">Variables used by this prompt</span>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Use <code className="bg-muted px-1 rounded text-[11px]">{"{{VARIABLE_NAME}}"}</code> placeholders in your prompt text. Each variable is linked to a data source below.
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Conditional blocks are supported with <code className="bg-muted px-1 rounded text-[11px]">{"{{#IF VARIABLE_NAME}}...{{/IF}}"}</code> or <code className="bg-muted px-1 rounded text-[11px]">{"{{IF VARIABLE_NAME}}...{{/IF}}"}</code>. The block is included only when the variable resolves to a non-blank value.
          </p>
        </div>
        {!variablesLoading && (
          <>
            {variables.length > 0 && (
              <div className="space-y-1.5">
                {variables.map((v, idx) => {
                  const bindingItem = EDITOR_BINDING_GROUPS.flatMap(g => g.items).find(bt => bt.value === v.bindingType);
                  const isUnset = !v.bindingType;
                  const shouldAutoOpen = autoOpenVarName === v.name;
                  
                  return (
                    <div key={v.name} className={`flex items-center gap-2 rounded-md border px-3 py-2 ${isUnset ? "border-destructive/50 bg-destructive/5" : "border-border bg-background"}`}>
                      {/* Variable badge */}
                      <span className="inline-flex items-center rounded bg-primary/10 text-primary px-2 py-0.5 text-[11px] font-mono font-semibold shrink-0 whitespace-nowrap">
                        {`{{${v.name}}}`}
                      </span>

                      {/* Arrow */}
                      <span className="text-muted-foreground text-xs shrink-0">→</span>

                      {/* Binding type selector */}
                      <Select
                        value={v.bindingType || undefined}
                        open={shouldAutoOpen ? true : undefined}
                        onOpenChange={(open) => {
                          if (!open && shouldAutoOpen) setAutoOpenVarName(null);
                        }}
                        onValueChange={(val) => {
                          updateVariable(idx, { bindingType: val });
                          setAutoOpenVarName(null);
                        }}
                      >
                        <SelectTrigger className={`h-7 text-xs flex-1 min-w-0 max-w-[280px] ${isUnset ? "border-destructive text-destructive" : ""}`}>
                          <SelectValue placeholder="Select data source…">
                            {bindingItem?.label || (isUnset ? "Select data source…" : v.bindingType)}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent className="max-h-80 z-50 w-[380px]">
                          {EDITOR_BINDING_GROUPS.map((group) => (
                            <div key={group.group}>
                              <div className="px-2 py-1.5 text-[10px] font-bold text-muted-foreground tracking-wider uppercase select-none bg-muted/50">
                                {group.group}
                              </div>
                              {group.items.map(bt => (
                                <SelectItem key={bt.value} value={bt.value} className="text-xs">
                                  <div>
                                    <span className="font-medium">{bt.label}</span>
                                    <span className="text-[10px] text-muted-foreground ml-1.5">— {bt.hint}</span>
                                  </div>
                                </SelectItem>
                              ))}
                            </div>
                          ))}
                        </SelectContent>
                      </Select>

                      {/* Error label when unset */}
                      {isUnset && (
                        <span className="text-[10px] text-destructive font-medium shrink-0">Required</span>
                      )}

                      {/* Required toggle */}
                      {!isUnset && (
                        <label className="flex items-center gap-1 shrink-0 cursor-pointer select-none" title="If required, job will fail when this data is missing">
                          <input
                            type="checkbox"
                            checked={v.required !== false}
                            onChange={(e) => updateVariable(idx, { required: e.target.checked })}
                            className="h-3 w-3 rounded border-input accent-primary"
                          />
                          <span className="text-[10px] text-muted-foreground">Req</span>
                        </label>
                      )}

                      {/* Remove */}
                      <button type="button" onClick={() => removeVariable(v.name)} className="text-muted-foreground hover:text-destructive p-0.5 rounded shrink-0" title="Remove variable">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-1.5 pt-1">
              <Input value={newVarName} onChange={(e) => setNewVarName(e.target.value)} placeholder="NEW_VARIABLE_NAME" className="h-7 text-xs font-mono flex-1 max-w-[220px]"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addVariable(); } }} />
              <Button type="button" variant="outline" size="sm" onClick={addVariable} className="h-7 px-2"><Plus className="h-3 w-3 mr-0.5" /> Add</Button>
            </div>
          </>
        )}
      </div>

      {/* Version description — only useful when saving new content */}
      <Input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Version description (optional)"
        className="text-sm"
      />

      {/* Prompt editor with keyword highlighting */}
      <div className="relative h-[450px] w-full rounded-md border border-input overflow-hidden">
        {/* Scrollable layer — both backdrop and textarea scroll together */}
        <div className="absolute inset-0 overflow-auto">
          {/* Sizing wrapper — grows to fit content so scroll works */}
          <div className="relative min-h-full">
            {/* Backdrop with highlighted text */}
            <div
              ref={backdropRef}
              aria-hidden="true"
              className="pointer-events-none p-3 text-sm whitespace-pre-wrap break-words"
              style={{ fontFamily: "inherit", lineHeight: "1.5rem", wordBreak: "break-word", minHeight: "100%" }}
            >
              {renderHighlightedPrompt(content, variables.map(v => v.name))}
            </div>
            {/* Actual textarea on top — transparent text so backdrop highlights show through */}
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Enter your AI prompt here…"
              className="absolute inset-0 w-full h-full resize-none bg-transparent border-0 outline-none p-3 text-sm"
              style={{ fontFamily: "inherit", lineHeight: "1.5rem", color: "transparent", caretColor: "hsl(var(--foreground))" }}
              spellCheck={false}
            />
          </div>
        </div>
      </div>

      {/* ── Action buttons (state-machine driven) ── */}
      <div className="flex flex-wrap gap-2 items-center">

        {/* Case A: content matches the active version */}
        {isActiveContent && (
          <Button type="button" size="sm" disabled
            className="opacity-60 cursor-not-allowed bg-muted text-muted-foreground border border-border"
          >
            <CheckCircle2 className="h-3 w-3 mr-1" />
            This is the Active Prompt
          </Button>
        )}

        {/* Case B: content matches a saved but NON-active version */}
        {!isActiveContent && matchedVersion && (
          <Button type="button" size="sm" onClick={handleActivateExisting} disabled={activating}>
            {activating
              ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Activating…</>
              : `Activate Version ${matchedVersion.version}`}
          </Button>
        )}

        {/* Case C: content is brand new (not saved anywhere) — offer Save & Set Active */}
        {!isActiveContent && !matchedVersion && (
          <Button type="button" size="sm" onClick={handleSaveAndActivate} disabled={activating}>
            {activating
              ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Saving…</>
              : "Save & Set Active"}
          </Button>
        )}

        {/* Save without activating — disabled if content already exists as a saved version */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleSaveOnly}
          disabled={saving || activating || !!matchedVersion}
          title={matchedVersion ? `Already saved as Version ${matchedVersion.version}` : undefined}
        >
          {saving ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Saving…</> : "Save"}
        </Button>

        {/* Flag when content already exists */}
        {matchedVersion && !isActiveContent && (
          <span className="text-xs text-muted-foreground self-center">
            Already Version {matchedVersion.version}
          </span>
        )}
      </div>

      {/* ── Version history dropdown ── */}
      <div className="space-y-2 pt-2 border-t border-border">
        <p className="text-xs text-muted-foreground">Load or remove a saved version:</p>
        <Select
          value={selectedVersionNum != null ? String(selectedVersionNum) : ""}
          onValueChange={handleVersionSelect}
        >
          <SelectTrigger className="w-full text-sm">
            <SelectValue placeholder="Select a version to load…" />
          </SelectTrigger>
          <SelectContent>
            {versions.length === 0 ? (
              <SelectItem value="__empty__" disabled>No saved versions</SelectItem>
            ) : (
              <>
                <SelectItem value="__clear__">— Clear selection —</SelectItem>
                {versions.map((v) => (
                  <SelectItem key={v.version} value={String(v.version)}>
                    <span className="flex items-center gap-1.5">
                      {v.is_active && <CheckCircle2 className="h-3 w-3 text-primary shrink-0" />}
                      <span>Version {v.version} – {v.description} – {formatDate(v.created_at)}</span>
                    </span>
                  </SelectItem>
                ))}
              </>
            )}
          </SelectContent>
        </Select>

        {/* Remove controls — only shown when a version is selected */}
        {selectedEntry && (
          <div className="flex items-center gap-2">
            {canRemoveSelected ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setConfirmRemoveOpen(true)}
                disabled={saving}
              >
                Remove Version {selectedEntry.version}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{removeBlockedReason}</p>
            )}
          </div>
        )}
      </div>

      {/* Remove confirmation dialog */}
      <AlertDialog open={confirmRemoveOpen} onOpenChange={setConfirmRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Version {selectedEntry?.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete Version {selectedEntry?.version} ("{selectedEntry?.description}").
              All remaining versions will be re-sequenced.
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
