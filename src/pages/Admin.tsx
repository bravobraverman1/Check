import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_FUNCTIONS_URL } from "@/config/publicEnv";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormSection } from "@/components/FormSection";
import { AiPromptEditor } from "@/components/AiPromptEditor";
import { AiInstructionsConstants } from "@/components/AiInstructionsConstants";
import { AiProgressBlock } from "@/components/AiProgressBlock";
import { AiRoutingOptionsSection } from "@/components/AiRoutingOptionsSection"; // kept for potential future use
import { BillingPanel } from "@/components/BillingPanel";
import { AiJobsDebugPanel } from "@/components/AiJobsDebugPanel";
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  ChevronRight,
  ChevronDown,
  FolderPlus,
  Loader2,
  Save,
  ExternalLink,
  Upload,
  FileText,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { fetchCategoriesWithSource, updateCategories, fetchProperties, type CategoriesFetchResult } from "@/lib/api";
import { CategoryLevel, isLeaf, getAllLeafPaths } from "@/data/categoryData";
import { config, DEFAULT_SHEET_TABS, getSheetTabName, setSheetTabName } from "@/config";
import type { LegalValue } from "@/data/defaultProperties";
import { invokeGoogleSheetsFunction } from "@/lib/supabaseGoogleSheets";
import { invokeEdgeFunction } from "@/lib/edgeAuth";
import { broadcastConfigChange } from "@/lib/configSync";
import { syncGoogleSheetQueries } from "@/lib/querySync";
import { GeminiSetupSection } from "@/components/GeminiSetupSection";
import { AiCollisionTuningSection } from "@/components/AiCollisionTuningSection";
import { CompareDatasheets } from "@/components/CompareDatasheets";
import { MpnPanel } from "@/components/MpnPanel";
import { getGeminiConfig, updateGeminiConfig, GEMINI_MODELS, DEFAULT_GEMINI_MODEL } from "@/lib/geminiConfig";
import { runAiAction, getInstructionFileForPrompt } from "@/lib/runAiAction";
import { buildDescriptionPrompt } from "@/lib/aiPromptBuilders";
import { parseTitleDescriptionJson } from "@/lib/parseTitleDescriptionJson";
import {
  getPromptVariablesInUse,
  normalizePromptVariableBindingType,
  resolvePromptVariables,
  type RuntimeContext,
  type PromptVariable,
} from "@/lib/resolvePromptVariables";
import { loadPromptVariables } from "@/lib/promptVariablesCache";
import { selectFirstCompatibleActivePrompt } from "@/lib/aiPromptCandidateSelection";
import { getAiActionRouting, type AiActionId } from "@/lib/aiRoutingConfig";
import { withBucket } from "@/lib/bucketAllocation";
import {
  getDefaultTestCsvCompareIgnoredColumns,
  getDefaultTestCsvCompareUnorderedRules,
  getTestCsvCompareIgnoredColumns,
  getTestCsvCompareUnorderedRules,
  setTestCsvCompareIgnoredColumns,
  setTestCsvCompareUnorderedRules,
} from "@/lib/testCsvCompareConfig";
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

// GitHub repository configuration
const GITHUB_REPO_OWNER = "bravobraverman1";
const GITHUB_REPO_NAME = "LS-Product-Creation-";
const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`;

// ── Helpers ─────────────────────────────────────────────────

function treeToPaths(tree: CategoryLevel[], prefix: string[] = []): string[] {
  const paths: string[] = [];
  for (const node of tree) {
    const current = [...prefix, node.name];
    // ALWAYS emit this node's path (parent OR leaf) so parent rows aren't
    // silently deleted from the Google Sheet on save.
    paths.push(current.join("/"));
    if (node.children && node.children.length > 0) {
      paths.push(...treeToPaths(node.children, current));
    }
  }
  return paths;
}

// ── Tree Node Editor ────────────────────────────────────────

interface TreeEditorNodeProps {
  node: CategoryLevel;
  path: string[];
  onRename: (path: string[], newName: string) => void;
  onDelete: (path: string[]) => void;
  onAddChild: (path: string[], childName: string) => void;
  expandAllSignal: number;
  expandAllValue: boolean | null;
  readOnly?: boolean;
}

function TreeEditorNode({
  node,
  path,
  onRename,
  onDelete,
  onAddChild,
  expandAllSignal,
  expandAllValue,
  readOnly = false,
}: TreeEditorNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(node.name);
  const [adding, setAdding] = useState(false);
  const [newChildName, setNewChildName] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const currentPath = [...path, node.name];
  const leaf = isLeaf(node);

  useEffect(() => {
    if (expandAllValue !== null) {
      setExpanded(expandAllValue);
    }
  }, [expandAllSignal, expandAllValue]);

  const handleRename = () => {
    if (editValue.trim() && editValue.trim() !== node.name) {
      onRename(currentPath, editValue.trim());
    }
    setEditing(false);
  };

  const handleAddChild = () => {
    if (newChildName.trim()) {
      onAddChild(currentPath, newChildName.trim());
      setNewChildName("");
      setAdding(false);
    }
  };

  return (
    <div>
      <div
        className="flex items-center gap-1 py-1 px-1 rounded-md hover:bg-muted/40 group transition-colors"
        style={{ paddingLeft: `${path.length * 16 + 4}px` }}
      >
        {!leaf ? (
          <button type="button" onClick={() => setExpanded(!expanded)} className="shrink-0 text-muted-foreground">
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-3.5" />
        )}

        {editing && !readOnly ? (
          <div className="flex items-center gap-1 flex-1">
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="h-6 text-xs flex-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <button type="button" onClick={handleRename}>
              <Check className="h-3.5 w-3.5 text-success" />
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
        ) : (
          <>
            <span className="text-sm flex-1 truncate">{node.name}</span>
            {!readOnly && (
              <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
                <button
                  type="button"
                  onClick={() => {
                    setEditValue(node.name);
                    setEditing(true);
                  }}
                  title="Rename"
                >
                  <Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
                <button type="button" onClick={() => setAdding(true)} title="Add child">
                  <FolderPlus className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!leaf && node.children && node.children.length > 0) {
                      // Immediately show toast instead of opening dialog
                      return;
                    }
                    setDeleteOpen(true);
                  }}
                  title={!leaf && node.children && node.children.length > 0 ? "Remove children first" : "Delete"}
                >
                  <Trash2
                    className={`h-3 w-3 text-muted-foreground ${!leaf && node.children && node.children.length > 0 ? "opacity-40 cursor-not-allowed" : "hover:text-destructive"}`}
                  />
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{node.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {!leaf ? "This will delete the category and all its children." : "This category will be removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onDelete(currentPath);
                setDeleteOpen(false);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {adding && !readOnly && (
        <div className="flex items-center gap-1 py-1" style={{ paddingLeft: `${(path.length + 1) * 16 + 8}px` }}>
          <Input
            value={newChildName}
            onChange={(e) => setNewChildName(e.target.value)}
            placeholder="New category name…"
            className="h-6 text-xs flex-1"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddChild();
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <button type="button" onClick={handleAddChild}>
            <Check className="h-3.5 w-3.5 text-success" />
          </button>
          <button type="button" onClick={() => setAdding(false)}>
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      )}

      {!leaf && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeEditorNode
              key={child.name}
              node={child}
              path={currentPath}
              onRename={onRename}
              onDelete={onDelete}
              onAddChild={onAddChild}
              expandAllSignal={expandAllSignal}
              expandAllValue={expandAllValue}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Admin Page ──────────────────────────────────────────────

const Admin = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const location = useLocation();
  const isOnAdminPage = location.pathname === "/admin";

  // ── Broadcast helper — uses the singleton persistent channel from configSync ──

  // ── Categories ──
  const {
    data: categoriesResult,
    error: categoriesError,
    isLoading: categoriesLoading,
  } = useQuery({
    queryKey: ["categories-with-source"],
    queryFn: fetchCategoriesWithSource,
    staleTime: 60_000,
    retry: 2,
    retryDelay: (attempt) => attempt * 1500,
  });

  const loadedTree = categoriesResult?.categories ?? [];
  const categoriesSource = categoriesResult?.source ?? "defaults";
  const loadedFromSheet = categoriesSource === "google-sheets" || categoriesSource === "apps-script";

  const [tree, setTree] = useState<CategoryLevel[]>([]);
  const [dirty, setDirty] = useState(false);
  const [addingRoot, setAddingRoot] = useState(false);
  const [newRootName, setNewRootName] = useState("");
  const [expandAllSignal, setExpandAllSignal] = useState(0);
  const [expandAllValue, setExpandAllValue] = useState<boolean | null>(null);
  // Editing is locked until categories are successfully loaded from Google Sheet
  const editingLocked = !loadedFromSheet || categoriesLoading || !!categoriesError;
  // Ref so that memoized callbacks always see the latest value (avoids stale closure)
  const editingLockedRef = useRef(editingLocked);
  editingLockedRef.current = editingLocked;

  const [billingKey, setBillingKey] = useState(0);
  useEffect(() => {
    if (isOnAdminPage) {
      setBillingKey((prev) => prev + 1);
    }
  }, [isOnAdminPage]);

  // Show error if categories failed to load (only on Admin page)
  useEffect(() => {
    if (categoriesError && isOnAdminPage) {
      console.error("Failed to load categories:", categoriesError);
      toast({
        variant: "destructive",
        title: "Failed to Load Categories",
        description:
          categoriesError instanceof Error ? categoriesError.message : "Could not load categories from Google Sheet",
      });
    }
  }, [categoriesError, isOnAdminPage, toast]);

  // Warn if loaded from defaults (not from sheet) — only show when user is on Admin page
  useEffect(() => {
    if (categoriesResult && !loadedFromSheet && isOnAdminPage) {
      toast({
        variant: "destructive",
        title: "⚠️ Categories NOT from Google Sheet",
        description:
          "Categories loaded from local defaults. Saving is DISABLED to prevent overwriting real data. Fix your Google Sheets connection first.",
      });
    }
  }, [categoriesResult, loadedFromSheet, isOnAdminPage, toast]);

  useEffect(() => {
    if (loadedTree.length > 0 && !dirty) setTree(loadedTree);
  }, [loadedTree, dirty]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!loadedFromSheet) {
        throw new Error(
          "Cannot save: categories were not loaded from Google Sheet. Fix your connection and reload before saving.",
        );
      }
      await updateCategories(treeToPaths(tree));
    },
    onSuccess: async () => {
      toast({ title: "Saved", description: "Categories updated — all connected users will refresh." });
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["categories-with-source"] });
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      // Notify all other connected clients to reload categories
      broadcastConfigChange("categories-saved");
    },
    onError: (err) => {
      toast({
        variant: "destructive",
        title: "Save Failed",
        description: err instanceof Error ? err.message : "Could not save.",
      });
    },
  });

  const modifyTree = (fn: (draft: CategoryLevel[]) => CategoryLevel[]) => {
    // SAFETY: Never allow tree modification if not synced with sheet
    // Uses ref to always read the CURRENT value, not a stale closure from first render
    if (editingLockedRef.current) {
      console.error("Blocked tree modification: categories not synced with Google Sheet");
      toast({
        variant: "destructive",
        title: "Edit Blocked",
        description: "Cannot modify categories — not synced with Google Sheet.",
      });
      return;
    }
    setTree((prev) => fn(JSON.parse(JSON.stringify(prev))));
    setDirty(true);
  };

  const findParentAndIndex = (
    nodes: CategoryLevel[],
    path: string[],
  ): { parent: CategoryLevel[] | null; index: number } => {
    if (path.length === 1) return { parent: nodes, index: nodes.findIndex((n) => n.name === path[0]) };
    const parentNode = nodes.find((n) => n.name === path[0]);
    if (!parentNode?.children) return { parent: null, index: -1 };
    return findParentAndIndex(parentNode.children, path.slice(1));
  };

  const handleRename = useCallback((path: string[], newName: string) => {
    modifyTree((draft) => {
      const { parent, index } = findParentAndIndex(draft, path);
      if (parent && index >= 0) parent[index] = { ...parent[index], name: newName };
      return draft;
    });
  }, []);

  const handleDelete = useCallback(
    (path: string[]) => {
      // SAFETY: Find the node first — refuse to delete if it has children
      const findNode = (nodes: CategoryLevel[], p: string[]): CategoryLevel | null => {
        if (p.length === 0) return null;
        const node = nodes.find((n) => n.name === p[0]);
        if (!node) return null;
        if (p.length === 1) return node;
        return findNode(node.children || [], p.slice(1));
      };
      const target = findNode(tree, path);
      if (target && target.children && target.children.length > 0) {
        toast({
          variant: "destructive",
          title: "Cannot Delete Parent Category",
          description: `"${target.name}" has ${target.children.length} child categor${target.children.length === 1 ? "y" : "ies"}. Delete or move all children first.`,
        });
        return;
      }
      modifyTree((draft) => {
        const { parent, index } = findParentAndIndex(draft, path);
        if (parent && index >= 0) parent.splice(index, 1);
        return draft;
      });
    },
    [tree, toast],
  );

  const handleAddChild = useCallback((parentPath: string[], childName: string) => {
    modifyTree((draft) => {
      const findNode = (nodes: CategoryLevel[], p: string[]): CategoryLevel | null => {
        if (p.length === 0) return null;
        const node = nodes.find((n) => n.name === p[0]);
        if (!node) return null;
        if (p.length === 1) return node;
        return findNode(node.children || [], p.slice(1));
      };
      const target = findNode(draft, parentPath);
      if (target) {
        if (!target.children) target.children = [];
        target.children.push({ name: childName });
      }
      return draft;
    });
  }, []);

  const handleAddRoot = () => {
    if (newRootName.trim()) {
      modifyTree((draft) => {
        draft.push({ name: newRootName.trim(), children: [] });
        return draft;
      });
      setNewRootName("");
      setAddingRoot(false);
    }
  };

  // ── Sheet Tab Config ──
  const [tabValues, setTabValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const tab of DEFAULT_SHEET_TABS) {
      initial[tab.key] = getSheetTabName(tab.key);
    }
    return initial;
  });

  const handleTabNameChange = (key: string, value: string) => {
    setTabValues((prev) => ({ ...prev, [key]: value }));
  };

  // Listen for real-time tab name updates broadcast from other clients
  useEffect(() => {
    const handler = (e: Event) => {
      const incoming = (e as CustomEvent<Record<string, string>>).detail;
      if (incoming) {
        setTabValues((prev) => ({ ...prev, ...incoming }));
      }
    };
    window.addEventListener("tab-names-updated", handler);
    return () => window.removeEventListener("tab-names-updated", handler);
  }, []);

  const saveTabNames = async () => {
    // 1. Write new tab names to localStorage
    for (const [key, value] of Object.entries(tabValues)) {
      setSheetTabName(key, value);
    }
    // 2. Tell all other connected clients to apply + do a Google Sync
    broadcastConfigChange("tab-names-saved", { tabValues });
    // 3. Run the same Google Sync locally (identical to pressing the nav button)
    await syncGoogleSheetQueries(queryClient, { includeDock: true });
    toast({ title: "Saved & Synced", description: "Tab names applied — Google Sync triggered for all users." });
  };

  // ── Connection Settings (from committed public config) ──
  const supabaseUrl = SUPABASE_URL;
  const supabaseAnonKey = SUPABASE_ANON_KEY;
  const supabaseFunctionsUrl = SUPABASE_FUNCTIONS_URL;

  // Regex pattern for validating and extracting project ref from Supabase URL
  const SUPABASE_URL_PATTERN = /https:\/\/([a-z0-9-]+)\.supabase\.co/i;
  const supabaseProjectRef = supabaseUrl.match(SUPABASE_URL_PATTERN)?.[1] || "";
  const functionsProjectRef = supabaseFunctionsUrl.match(SUPABASE_URL_PATTERN)?.[1] || "";

  // Validate if URL is a proper Supabase URL
  const isValidSupabaseUrl = SUPABASE_URL_PATTERN.test(supabaseUrl);
  const isFunctionsUrlMatch = !!supabaseFunctionsUrl && !!supabaseUrl && supabaseFunctionsUrl.startsWith(supabaseUrl);
  const isFunctionsProjectMatch =
    !functionsProjectRef || !supabaseProjectRef || functionsProjectRef === supabaseProjectRef;

  const [testingConnection, setTestingConnection] = useState(false);
  const [refreshingSheets, setRefreshingSheets] = useState(false);

  const testSupabaseConnection = async () => {
    setTestingConnection(true);
    try {
      // Test the edge function connection (credentials should be in Supabase secrets)
      const { data, error } = await invokeGoogleSheetsFunction<{
        useDefaults?: boolean;
        products?: unknown[];
        categoryPathCount?: number;
      }>({
        action: "read",
        // No credentials in request - should use environment variables
      });

      if (error) {
        // Provide specific error messages based on error type
        let errorMessage = error.message || "Unknown error";

        // Check for common error scenarios
        if (error.message?.includes("404") || error.message?.includes("not found")) {
          errorMessage =
            "Edge Function not deployed. Please run the 'Deploy Google Sheets Connection' workflow in GitHub Actions (Step 5).";
        } else if (error.message?.includes("403") || error.message?.includes("Forbidden")) {
          errorMessage =
            "Access denied. Make sure your Google Sheet is shared with the service account email (found in your JSON key file).";
        } else if (error.message?.includes("401") || error.message?.includes("Unauthorized")) {
          errorMessage =
            "Authentication failed. Check that GOOGLE_SERVICE_ACCOUNT_KEY is correctly set in Supabase secrets.";
        }

        toast({
          variant: "destructive",
          title: "Connection Error",
          description: errorMessage,
        });
        return;
      }

      if (data?.useDefaults) {
        toast({
          variant: "destructive",
          title: "⚠️ Cannot Read Secrets",
          description:
            "The Edge Function cannot read GOOGLE_SERVICE_ACCOUNT_KEY and GOOGLE_SHEET_ID. Most likely cause: You added secrets AFTER deploying the function. Solution: Run the 'Deploy Google Sheets Connection' workflow in GitHub Actions (this redeploys the function with your secrets). See the yellow box below for step-by-step instructions.",
        });
      } else {
        const productCount = data?.products?.length ?? 0;
        const categoryCount = data?.categoryPathCount ?? 0;
        toast({
          title: "Connected ✅",
          description: `Successfully connected to your Google Sheet! Found ${productCount} products and ${categoryCount} categories.`,
        });
      }
    } catch (error) {
      let errorMessage = "An unexpected error occurred.";

      if (error instanceof Error) {
        // Parse fetch/network errors
        if (error.message.includes("Failed to fetch") || error.message.includes("NetworkError")) {
          errorMessage = "Network error. Check your internet connection and that the Supabase project URL is correct.";
        } else if (error.message.includes("404")) {
          errorMessage = "Edge Function not found. Please deploy it using GitHub Actions (Step 5).";
        } else {
          errorMessage = error.message;
        }
      }

      toast({
        variant: "destructive",
        title: "Connection Error",
        description: errorMessage,
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleForceRefreshData = async () => {
    if (refreshingSheets) return;
    setRefreshingSheets(true);
    try {
      await syncGoogleSheetQueries(queryClient, { includeDock: true });
      toast({ title: "Cache cleared", description: "Data will be reloaded from Google Sheets on next request." });
    } catch {
      toast({
        variant: "destructive",
        title: "Sync failed",
        description: "Could not refresh Google Sheets data.",
      });
    } finally {
      setRefreshingSheets(false);
    }
  };

  // ── AI Model Selection ──
  const [selectedModel, setSelectedModel] = useState(() => getGeminiConfig().model || DEFAULT_GEMINI_MODEL);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [testIgnoredColumns, setTestIgnoredColumns] = useState<string[]>(() => getTestCsvCompareIgnoredColumns());
  const [testIgnoredColumnInput, setTestIgnoredColumnInput] = useState("");
  const [testUnorderedRules, setTestUnorderedRules] = useState(() => getTestCsvCompareUnorderedRules());
  const [testUnorderedRuleTitleInput, setTestUnorderedRuleTitleInput] = useState("");
  const [testUnorderedRuleSymbolInput, setTestUnorderedRuleSymbolInput] = useState(";");
  const [adminDescPdfFile, setAdminDescPdfFile] = useState<File | null>(null);
  const [adminDescFittingType, setAdminDescFittingType] = useState("");
  const [adminDescMode, setAdminDescMode] = useState<"technical" | "marketing">("technical");
  const [adminDescriptionOutput, setAdminDescriptionOutput] = useState("");
  const [isGeneratingAdminDescription, setIsGeneratingAdminDescription] = useState(false);
  const [isCancellingAdminDescription, setIsCancellingAdminDescription] = useState(false);
  const [adminDescProgress, setAdminDescProgress] = useState(0);
  const adminDescInputRef = useRef<HTMLInputElement | null>(null);
  const adminDescStartedAtRef = useRef<number | null>(null);
  const adminDescJobIdRef = useRef<string | null>(null);
  const adminDescCancelRequestedRef = useRef(false);
  const adminDescCancelSentRef = useRef(false);
  const [adminDescDebugData, setAdminDescDebugData] = useState<{ prompt: string; rawResponse: string } | null>(null);

  const cancelAdminDescriptionJob = useCallback(async (jobId: string) => {
    const normalizedJobId = jobId.trim();
    if (!normalizedJobId) return;
    if (adminDescCancelSentRef.current) return;

    adminDescCancelSentRef.current = true;
    setIsCancellingAdminDescription(true);
    try {
      const { error } = await invokeEdgeFunction("ai-jobs", {
        body: { action: "cancel", jobId: normalizedJobId },
      });
      if (error) {
        toast({
          variant: "destructive",
          title: "Cancel failed",
          description: error.message || "Could not cancel this AI job.",
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Cancel failed",
        description: error instanceof Error ? error.message : "Could not cancel this AI job.",
      });
    } finally {
      setIsCancellingAdminDescription(false);
    }
  }, [toast]);

  const handleCancelAdminDescription = useCallback(() => {
    adminDescCancelRequestedRef.current = true;
    const existingJobId = adminDescJobIdRef.current;
    if (existingJobId) {
      void cancelAdminDescriptionJob(existingJobId);
      return;
    }
    toast({ title: "Cancelling", description: "Cancellation requested. Waiting for job to initialize..." });
  }, [cancelAdminDescriptionJob, toast]);

  // Check if Google Sheets credentials are configured
  // Note: Credentials are stored ONLY as Supabase secrets, not in browser storage for security

  // ── LEGAL Editor ──
  const { data: propData } = useQuery({ queryKey: ["properties"], queryFn: fetchProperties, staleTime: 60_000 });
  const properties = propData?.properties ?? [];
  const legalValues = propData?.legalValues ?? [];

  const [selectedLegalProp, setSelectedLegalProp] = useState("");
  const legalForProp = useMemo(
    () => legalValues.filter((l) => l.propertyName === selectedLegalProp).map((l) => l.allowedValue),
    [legalValues, selectedLegalProp],
  );
  const dropdownProps = useMemo(
    () => properties.filter((p) => p.inputType === "dropdown").map((p) => p.name),
    [properties],
  );
  const defaultTestIgnoredColumns = useMemo(() => getDefaultTestCsvCompareIgnoredColumns(), []);
  const defaultTestUnorderedRules = useMemo(() => getDefaultTestCsvCompareUnorderedRules(), []);

  const addIgnoredColumn = useCallback((raw: string) => {
    const value = raw.trim().replace(/\s+/g, " ");
    if (!value) return;
    setTestIgnoredColumns((prev) => {
      const exists = prev.some((entry) => entry.toLowerCase() === value.toLowerCase());
      if (exists) return prev;
      return [...prev, value];
    });
  }, []);

  const removeIgnoredColumn = useCallback((title: string) => {
    setTestIgnoredColumns((prev) => prev.filter((entry) => entry.toLowerCase() !== title.toLowerCase()));
  }, []);

  const addUnorderedRule = useCallback((rawTitle: string, rawSymbol: string) => {
    const title = rawTitle.trim().replace(/\s+/g, " ");
    const symbol = rawSymbol.trim();
    if (!title || !symbol) return;

    setTestUnorderedRules((prev) => {
      const exists = prev.some((entry) => entry.title.toLowerCase() === title.toLowerCase() && entry.symbol === symbol);
      if (exists) return prev;
      return [...prev, { title, symbol }];
    });
  }, []);

  const removeUnorderedRule = useCallback((title: string, symbol: string) => {
    setTestUnorderedRules((prev) => prev.filter((entry) => !(entry.title === title && entry.symbol === symbol)));
  }, []);

  const saveTestCompareSettings = useCallback(() => {
    const saved = setTestCsvCompareIgnoredColumns(testIgnoredColumns);
    const savedRules = setTestCsvCompareUnorderedRules(testUnorderedRules);
    setTestIgnoredColumns(saved);
    setTestUnorderedRules(savedRules);
    broadcastConfigChange("test-csv-compare-settings-saved", {
      ignoredColumns: saved,
      unorderedRules: savedRules,
    });
    toast({ title: "Saved", description: "Test Form settings updated for all users." });
  }, [testIgnoredColumns, testUnorderedRules, toast]);

  const resetTestCompareSettings = useCallback(() => {
    const defaults = getDefaultTestCsvCompareIgnoredColumns();
    const defaultRules = getDefaultTestCsvCompareUnorderedRules();
    setTestIgnoredColumns(defaults);
    setTestUnorderedRules(defaultRules);
    const saved = setTestCsvCompareIgnoredColumns(defaults);
    const savedRules = setTestCsvCompareUnorderedRules(defaultRules);
    broadcastConfigChange("test-csv-compare-settings-saved", {
      ignoredColumns: saved,
      unorderedRules: savedRules,
    });
    toast({ title: "Reset", description: "Test Form settings reset to defaults." });
  }, [toast]);

  const handleCreateAdminDescription = useCallback(async () => {
    if (isGeneratingAdminDescription) return;
    if (!adminDescPdfFile) {
      toast({
        variant: "destructive",
        title: "Datasheet required",
        description: "Upload one PDF datasheet first.",
      });
      return;
    }
    if (!getGeminiConfig().enabled) {
      toast({
        variant: "destructive",
        title: "Gemini AI is disabled",
        description: "Enable Gemini AI in Admin first.",
      });
      return;
    }

    setIsGeneratingAdminDescription(true);
    setIsCancellingAdminDescription(false);
    setAdminDescProgress(2);
    adminDescStartedAtRef.current = Date.now();
    adminDescJobIdRef.current = null;
    adminDescCancelRequestedRef.current = false;
    adminDescCancelSentRef.current = false;
    setAdminDescriptionOutput("");
    setAdminDescDebugData(null);

    try {
      const modeForRun: "technical" | "marketing" = adminDescMode;
      let generationMs: number | null = null;
      const actionKey: AiActionId =
        modeForRun === "marketing"
          ? "product_generate_description_marketing"
          : "product_generate_description_technical";
      const routingConfig = getAiActionRouting(actionKey);
      const selectedPromptType = modeForRun === "marketing" ? "admin_marketing" : "admin_technical";

      if (!routingConfig.enabled) {
        toast({
          variant: "destructive",
          title: "Action Disabled",
          description: "Enable this action in Admin → AI Routing Options.",
        });
        return;
      }

      const fittingInstruction = adminDescFittingType.trim() ? `Fitting Type: ${adminDescFittingType.trim()}` : "";

      const baseRuntimeCtx: RuntimeContext = {
        datasheetUpload: {
          bucket: "",
          path: "",
          filename: adminDescPdfFile.name,
          label: "datasheet",
        },
        adminCreateDescriptionDatasheetUpload: {
          bucket: "",
          path: "",
          filename: adminDescPdfFile.name,
          label: "datasheet",
        },
        additionalInstructionsTitle: fittingInstruction || undefined,
        adminFittingType: adminDescFittingType.trim() || undefined,
      };

      const activePromptSelection = await selectFirstCompatibleActivePrompt([selectedPromptType], baseRuntimeCtx);
      if (!activePromptSelection?.prompt) {
        toast({
          variant: "destructive",
          title: "No Active Prompt",
          description: `Activate prompt: ${selectedPromptType}`,
        });
        return;
      }

      const promptTemplate = activePromptSelection.prompt;
      const promptHasTemplateVariables = promptTemplate.includes("{{");
      const promptVariables = promptHasTemplateVariables ? await loadPromptVariables(selectedPromptType) : [];
      const activePromptVariables = promptHasTemplateVariables
        ? getPromptVariablesInUse({
            promptType: selectedPromptType,
            activeVersionContent: promptTemplate,
            variables: promptVariables,
          })
        : [];

      const usesBinding = (bindingType: PromptVariable["bindingType"]) =>
        activePromptVariables.some(
          (variable) => normalizePromptVariableBindingType(String(variable.bindingType || "")) === bindingType,
        );

      const shouldAttachInstructionPdf = routingConfig.requireInstructionPdf || usesBinding("instruction_pdf");
      const instructionFile = shouldAttachInstructionPdf ? await getInstructionFileForPrompt(selectedPromptType) : null;

      let resolvedPrompt = promptTemplate;
      const resolverRequestedLabels = new Set<string>();

      if (promptHasTemplateVariables) {
        const runtimeCtx: RuntimeContext = {
          instructionPdf: instructionFile
            ? {
                bucket: "document-uploads-constant",
                path: "",
                filename: instructionFile.file.name,
                label: "instructions",
              }
            : null,
          datasheetUpload: {
            bucket: "",
            path: "",
            filename: adminDescPdfFile.name,
            label: "datasheet",
          },
          adminCreateDescriptionDatasheetUpload: {
            bucket: "",
            path: "",
            filename: adminDescPdfFile.name,
            label: "datasheet",
          },
          additionalInstructionsTitle: fittingInstruction || undefined,
          adminFittingType: adminDescFittingType.trim() || undefined,
        };

        const resolveResult = resolvePromptVariables(
          {
            promptType: selectedPromptType,
            promptName: selectedPromptType,
            activeVersionContent: promptTemplate,
            variables: activePromptVariables,
          },
          runtimeCtx,
        );

        if (resolveResult.validationErrors.length > 0) {
          toast({
            variant: "destructive",
            title: "Missing Required Input",
            description: resolveResult.validationErrors[0],
          });
          return;
        }

        resolvedPrompt = resolveResult.finalPrompt;
        for (const file of resolveResult.files) {
          if (file.label) resolverRequestedLabels.add(file.label);
        }
      }

      const finalPrompt = buildDescriptionPrompt({
        resolvedPrompt,
        includeAdditionalInstructions: routingConfig.includeAdditionalInstructions,
        additionalInstructions: fittingInstruction,
      });

      const unresolvedPlaceholders = Array.from(new Set(finalPrompt.match(/\{\{[^}]+\}\}/g) || []));
      if (unresolvedPlaceholders.length > 0) {
        toast({
          variant: "destructive",
          title: "Prompt Variable Error",
          description: `Unresolved prompt variables: ${unresolvedPlaceholders.join(", ")}`,
        });
        return;
      }

      const shouldAttachInstructionForRun =
        routingConfig.requireInstructionPdf || resolverRequestedLabels.has("instructions");
      if (routingConfig.requireInstructionPdf && !instructionFile) {
        toast({
          variant: "destructive",
          title: "Missing Instruction PDF",
          description: "Upload the instruction PDF for this prompt in AI Prompts before generating.",
        });
        return;
      }

      const filesToUpload: Array<{ file: File; label: string }> = [{ file: adminDescPdfFile, label: "datasheet" }];
      if (shouldAttachInstructionForRun && instructionFile) {
        filesToUpload.unshift({ file: instructionFile.file, label: "instructions" });
      }


      await withBucket(filesToUpload, async (fileRefs) => {
        // Use the same descriptionKeys and paragraph break logic as the form parser
        const { parseTitleDescriptionJson } = await import("@/lib/parseTitleDescriptionJson");
        // descriptionKeys from parseTitleDescriptionJson.ts
        const descriptionKeys = [
          "description",
          "product_description",
          "product-description",
          "ai_description",
          "ai-description",
          "chatgpt_description",
          "chatgpt-description",
          "body",
          "copy",
        ];
        // Use collapseBlankLines from parseTitleDescriptionJson.ts
        const { collapseBlankLines } = await import("@/lib/parseTitleDescriptionJson");

        // Use the same extraction logic as the form parser
        const extractDescription = (value: unknown, depth = 0): string | null => {
          if (depth > 6 || value == null) return null;
          if (typeof value === "string") {
            const text = value.trim();
            if (!text) return null;
            try {
              const parsed = JSON.parse(text);
              return extractDescription(parsed, depth + 1);
            } catch {
              return null;
            }
          }
          if (Array.isArray(value)) {
            for (const item of value) {
              const found = extractDescription(item, depth + 1);
              if (found) return found;
            }
            return null;
          }
          if (typeof value !== "object") return null;
          const obj = value as Record<string, unknown>;
          for (const [rawKey, rawVal] of Object.entries(obj)) {
            if (typeof rawVal !== "string") continue;
            if (!descriptionKeys.includes(rawKey) && !descriptionKeys.includes(rawKey.replace(/[_-]/g, ""))) continue;
            const desc = rawVal.trim();
            if (desc) return desc;
          }
          for (const nested of Object.values(obj)) {
            const found = extractDescription(nested, depth + 1);
            if (found) return found;
          }
          return null;
        };

        let attempts = 0;
        let generationSucceeded = false;

        while (attempts < 2) {
          attempts += 1;
          try {
            const { response } = await runAiAction({
              actionKey,
              userTaskPrompt: finalPrompt,
              prebuiltPrompt: true,
              type: "generic", // Matches standard form execution constraints
              mode: "json", // Matches form's native JSON expectation
              files: fileRefs,
              debugPromptType: selectedPromptType,
              responseGuard: { minTextLength: 40 },
              maxValidationRetries: 1, // Matches form auto-retry behavior
              onProgress: (progress) => {
                if (progress.jobId) {
                  adminDescJobIdRef.current = progress.jobId;
                  if (adminDescCancelRequestedRef.current && !adminDescCancelSentRef.current) {
                    void cancelAdminDescriptionJob(progress.jobId);
                  }
                }
                const candidate = Number(progress.progress || 0);
                setAdminDescProgress((prev) => Math.max(prev, Math.max(2, Math.min(99, Math.floor(candidate)))));
              },
            });

            if (!response.success || response.error) {
              throw new Error(response.error || "Description generation failed.");
            }

            generationMs =
              typeof response.meta?.latencyMs === "number" && Number.isFinite(response.meta.latencyMs)
                ? response.meta.latencyMs
                : adminDescStartedAtRef.current
                  ? Math.max(0, Date.now() - adminDescStartedAtRef.current)
                  : null;

            const payload = response.result ?? response.data ?? null;
            const rawResult =
              typeof payload === "string"
                ? payload
                : payload
                  ? JSON.stringify(payload)
                  : "";

            setAdminDescDebugData({ prompt: finalPrompt, rawResponse: rawResult });

            const parsed = parseTitleDescriptionJson(rawResult);
            const recoveredDescription = extractDescription(payload) || extractDescription(rawResult);
            const descriptionSource = parsed?.description || recoveredDescription || "";

            if (!descriptionSource.trim()) {
              if (attempts < 2) {
                continue;
              }
              throw new Error("AI returned invalid title/description JSON. Expected {\"title\":\"...\",\"description\":\"...\"}.");
            }


            // Enforce single \n between paragraphs, no empty lines
            let finalDescription = collapseBlankLines(descriptionSource);
            // If there are no \n, try to split into paragraphs by period+capital (for AI that returns a block)
            if (!/\n/.test(finalDescription)) {
              // Try to split at sentence boundaries for 4 paragraphs
              const paraCandidates = finalDescription.split(/(?<=[.?!])\s+(?=[A-Z])/g);
              if (paraCandidates.length >= 4) {
                finalDescription = paraCandidates.map(p => p.trim()).filter(Boolean).join("\n");
              }
            }
            // Remove any accidental double newlines
            finalDescription = finalDescription.replace(/\n{2,}/g, "\n");

            if (!finalDescription) {
              throw new Error("AI returned empty description output.");
            }

            setAdminDescriptionOutput(finalDescription);
            setAdminDescProgress(100);
            generationSucceeded = true;
            break;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (adminDescCancelRequestedRef.current || /cancelled|canceled|cancel/i.test(message)) {
              throw new Error("Description generation cancelled.");
            }
            const timeoutLike = /timed?\s*out|timeout|deadline|abort/i.test(message);
            if (timeoutLike && attempts < 2) {
              continue;
            }
            throw err;
          }
        }

        if (!generationSucceeded) {
          throw new Error("AI returned invalid JSON format after retry. Please regenerate.");
        }
      });

      toast({
        title: "Description created",
        description: generationMs
          ? `Generated ${modeForRun} description in ${(generationMs / 1000).toFixed(1)}s.`
          : `Generated ${modeForRun} description successfully.`,
      });
    } catch (error) {
      if (error instanceof Error && /cancelled|canceled|cancel/i.test(error.message)) {
        toast({
          title: "Description generation cancelled",
          description: "AI job was cancelled.",
        });
      } else {
      toast({
        variant: "destructive",
        title: "Create Description failed",
        description: error instanceof Error ? error.message : "Unknown error",
      });
      }
    } finally {
      setIsGeneratingAdminDescription(false);
      setIsCancellingAdminDescription(false);
      if (adminDescProgress < 100) setAdminDescProgress(0);
      adminDescJobIdRef.current = null;
      adminDescCancelRequestedRef.current = false;
      adminDescCancelSentRef.current = false;
      adminDescStartedAtRef.current = null;
    }
  }, [
    adminDescFittingType,
    adminDescMode,
    adminDescPdfFile,
    isGeneratingAdminDescription,
    adminDescProgress,
    toast,
    cancelAdminDescriptionJob,
  ]);

  // ── Leaf paths for reference ──
  const leafPaths = useMemo(() => getAllLeafPaths(tree), [tree]);

  return (
    <div className="space-y-6">
      {/* Usage & Billing */}
      <FormSection title="Usage & Billing" defaultOpen>
        <BillingPanel key={`billing-${billingKey}`} />
      </FormSection>

      {/* Compare Two Datasheets */}
      <FormSection title="Compare Two Datasheets" defaultOpen={true} collapsible={false}>
        <CompareDatasheets />
      </FormSection>

      {/* Create Description */}
      <FormSection title="Create Description" defaultOpen={true} collapsible={false}>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Supplier Datasheet (PDF)
            </Label>
            <div className="flex items-center gap-2">
              <label className="flex-1 max-w-xl">
                <input
                  ref={adminDescInputRef}
                  id="admin-desc-datasheet"
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onClick={(event) => {
                    (event.currentTarget as HTMLInputElement).value = "";
                  }}
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    if (!file) {
                      setAdminDescPdfFile(null);
                      return;
                    }
                    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
                    if (!isPdf) {
                      toast({
                        variant: "destructive",
                        title: "Invalid file",
                        description: "Please upload a PDF datasheet.",
                      });
                      event.target.value = "";
                      setAdminDescPdfFile(null);
                      return;
                    }
                    setAdminDescPdfFile(file);
                  }}
                />
                <div className="flex items-center gap-2 border border-border rounded-md px-3 h-9 text-sm cursor-pointer hover:bg-muted/30 transition-colors">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className={adminDescPdfFile ? "text-foreground" : "text-muted-foreground"}>
                    {adminDescPdfFile ? adminDescPdfFile.name : "Choose PDF file..."}
                  </span>
                </div>
              </label>
              {adminDescPdfFile && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 text-xs"
                  onClick={() => {
                    setAdminDescPdfFile(null);
                    if (adminDescInputRef.current) adminDescInputRef.current.value = "";
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Upload one datasheet PDF only.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="admin-desc-fitting-type">Fitting Type:</Label>
            <Input
              id="admin-desc-fitting-type"
              value={adminDescFittingType}
              onChange={(event) => setAdminDescFittingType(event.target.value)}
              placeholder="Optional"
              className="max-w-xl"
            />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              type="button"
              variant={isGeneratingAdminDescription || !adminDescPdfFile ? "outline" : "default"}
              size="sm"
              className={`h-9 ${!(isGeneratingAdminDescription || !adminDescPdfFile) ? "bg-blue-600 hover:bg-blue-700 text-white" : ""}`}
              onClick={() => {
                void handleCreateAdminDescription();
              }}
              disabled={isGeneratingAdminDescription || !adminDescPdfFile}
            >
              {isGeneratingAdminDescription ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> Generating...
                </>
              ) : (
                "Generate Description"
              )}
            </Button>
            {isGeneratingAdminDescription && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9"
                onClick={handleCancelAdminDescription}
                disabled={isCancellingAdminDescription}
              >
                {isCancellingAdminDescription ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> Cancelling...
                  </>
                ) : (
                  "Cancel"
                )}
              </Button>
            )}
            <div className="flex items-center rounded-full border border-border overflow-hidden text-xs font-medium h-9">
              <button
                type="button"
                onClick={() => setAdminDescMode("technical")}
                disabled={isGeneratingAdminDescription}
                className={`px-3 h-full transition-colors ${adminDescMode === "technical" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted/50"}`}
              >
                Technical
              </button>
              <button
                type="button"
                onClick={() => setAdminDescMode("marketing")}
                disabled={isGeneratingAdminDescription}
                className={`px-3 h-full transition-colors ${adminDescMode === "marketing" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted/50"}`}
              >
                Marketing
              </button>
            </div>
          </div>


          {isGeneratingAdminDescription && (
            <AiProgressBlock
              title={adminDescProgress >= 90 ? "Finalizing description" : "Generating description"}
              progress={Math.max(2, adminDescProgress)}
              tags={[adminDescMode === "marketing" ? "Marketing" : "Technical"]}
            />
          )}

          <div className="space-y-2">
            <Label htmlFor="ai-admin-description">AI-Admin-Description</Label>
            <Textarea
              id="ai-admin-description"
              value={adminDescriptionOutput}
              onChange={(event) => setAdminDescriptionOutput(event.target.value)}
              placeholder="Generated description will appear here"
              className="min-h-[220px]"
            />
          </div>

          <FormSection title="Create Description Raw Prompt & Output" defaultOpen={false}>
            <div className="space-y-2 pt-1">
              <Textarea
                id="admin-desc-raw-prompt-output"
                readOnly
                value={adminDescDebugData
                  ? `Raw Prompt Input:\n${adminDescDebugData.prompt}\n\nRaw AI Output:\n${adminDescDebugData.rawResponse}`
                  : ""}
                placeholder="Run Create Description to see raw prompt input and raw AI output."
                className="min-h-[260px] font-mono text-xs"
              />
            </div>
          </FormSection>

          <FormSection title="Create Description Debug Output" defaultOpen={false}>
            <div className="space-y-2 pt-1">
              <Textarea
                id="admin-desc-debug-output"
                readOnly
                value={adminDescDebugData
                  ? `Final Prompt Sent to AI:\n${adminDescDebugData.prompt}\n\nRaw AI Response:\n${adminDescDebugData.rawResponse}`
                  : ""}
                placeholder="Run Create Description to see debug events."
                className="min-h-[260px] font-mono text-xs"
              />
            </div>
          </FormSection>
        </div>
      </FormSection>

      {/* AI Prompts (merged: prompts + per-prompt instruction PDFs) */}
      <FormSection title="AI Prompts" defaultOpen={false}>
        <p className="text-xs text-muted-foreground mb-4">
          All AI prompts, instruction PDFs, and variable definitions. Each prompt has its own versioned content,
          optional instruction PDF, and variable list.
        </p>

        <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wide mb-2">
          Data Generation Prompts
        </h3>
        <FormSection title="Data – Two PDFs" defaultOpen={false}>
          <AiPromptEditor heading="Data – Two PDFs" promptType="product_data" hideHeading />
        </FormSection>
        <div className="border-t border-border my-4" />
        <FormSection title="Data – Datasheet Only" defaultOpen={false}>
          <AiPromptEditor heading="Data – Datasheet Only" promptType="data_title_datasheet" hideHeading />
        </FormSection>
        <div className="border-t border-border my-4" />
        <FormSection title="Data – Webpage Only" defaultOpen={false}>
          <AiPromptEditor heading="Data – Webpage Only" promptType="data_title_webpage" hideHeading />
        </FormSection>

        <div className="border-t-2 border-primary/20 my-6" />
        <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wide mb-2">
          Title & Description Prompts
        </h3>
        <FormSection title="Title & Description – Technical" defaultOpen={false}>
          <AiPromptEditor heading="Title & Description – Technical" promptType="technical" hideHeading />
        </FormSection>
        <div className="border-t border-border my-4" />
        <FormSection title="Title & Description – Marketing" defaultOpen={false}>
          <AiPromptEditor heading="Title & Description – Marketing" promptType="marketing" hideHeading />
        </FormSection>

        <div className="border-t-2 border-primary/20 my-6" />
        <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wide mb-2">Admin Tab Prompts</h3>
        <FormSection title="Compare Two Datasheets" defaultOpen={false}>
          <AiPromptEditor heading="Compare Two Datasheets" promptType="compare_sheets" hideHeading />
        </FormSection>
        <div className="border-t border-border my-4" />
        <FormSection title="Create Description - Admin Technical" defaultOpen={false}>
          <AiPromptEditor heading="Create Description - Admin Technical" promptType="admin_technical" hideHeading />
        </FormSection>
        <div className="border-t border-border my-4" />
        <FormSection title="Create Description - Admin Marketing" defaultOpen={false}>
          <AiPromptEditor heading="Create Description - Admin Marketing" promptType="admin_marketing" hideHeading />
        </FormSection>
      </FormSection>

      {/* MPN Manager */}
      <FormSection title="MPN Manager" defaultOpen={false}>
        <MpnPanel mode="manager" />
      </FormSection>

      {/* AI Jobs Debug */}
      <FormSection title="AI Jobs Debug" defaultOpen={false}>
        <AiJobsDebugPanel />
      </FormSection>

      {/* AI Routing Options — hidden from UI, underlying routing code still active */}

      {/* Extra Settings */}
      <FormSection title="Extra Settings" defaultOpen={false}>
        <div className="space-y-4">
          <FormSection title="MPN Settings" defaultOpen={false}>
            <MpnPanel mode="set-next" />
          </FormSection>

          <FormSection title="Sheet Tab Names" defaultOpen={false}>
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Configure the exact Google Sheet tab names used by this application.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {DEFAULT_SHEET_TABS.map((tab) => (
                  <div key={tab.key} className="space-y-1">
                    <Label className="text-xs font-medium">{tab.label}</Label>
                    <Input
                      value={tabValues[tab.key] || ""}
                      onChange={(e) => handleTabNameChange(tab.key, e.target.value)}
                      className="h-8 text-sm font-mono"
                    />
                  </div>
                ))}
              </div>
              <Button type="button" size="sm" onClick={saveTabNames}>
                <Save className="h-3.5 w-3.5 mr-1" /> Save Tab Names
              </Button>
            </div>
          </FormSection>

          <FormSection title="AI Model" defaultOpen={false}>
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Select the Gemini AI model used for all AI features. Requires{" "}
                <code className="text-xs bg-muted px-1 rounded">GEMINI_API_KEY</code> in Supabase secrets.
              </p>
              <div className="space-y-2">
                <Label className="text-xs font-medium">Active Model</Label>
                <div className="flex items-center gap-2">
                  <select
                    value={pendingModel ?? selectedModel}
                    onChange={(e) => setPendingModel(e.target.value)}
                    className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring flex-1"
                  >
                    {GEMINI_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                {(() => {
                  const chosen = GEMINI_MODELS.find((m) => m.id === (pendingModel ?? selectedModel));
                  return chosen ? <p className="text-xs text-muted-foreground">{chosen.description}</p> : null;
                })()}
                {pendingModel && pendingModel !== selectedModel && (
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        updateGeminiConfig({ model: pendingModel });
                        setSelectedModel(pendingModel);
                        setPendingModel(null);
                        broadcastConfigChange("ai-model-changed", { model: pendingModel });
                        toast({
                          title: "Model Updated",
                          description: `AI model set to ${GEMINI_MODELS.find((m) => m.id === pendingModel)?.label || pendingModel}`,
                        });
                      }}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" /> Confirm
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setPendingModel(null)}>
                      <X className="h-3.5 w-3.5 mr-1" /> Cancel
                    </Button>
                  </div>
                )}
                {!pendingModel && (
                  <p className="text-xs font-medium text-muted-foreground">
                    Current:{" "}
                    <span className="text-foreground">
                      {GEMINI_MODELS.find((m) => m.id === selectedModel)?.label || selectedModel}
                    </span>
                  </p>
                )}
              </div>
            </div>
          </FormSection>

          <FormSection title="AI Collision Tuning" defaultOpen={false}>
            <AiCollisionTuningSection />
          </FormSection>

          <FormSection title="Test Form" defaultOpen={false}>
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Choose column titles to ignore in Test tab CSV comparisons. Matching is by title name (not column
                position), so it still works when CSVs have different widths.
              </p>

              <div className="flex flex-wrap gap-2">
                {testIgnoredColumns.map((title) => (
                  <span
                    key={title}
                    className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-1 text-xs"
                  >
                    {title}
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => removeIgnoredColumn(title)}
                      aria-label={`Remove ${title}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                {testIgnoredColumns.length === 0 && (
                  <span className="text-xs text-muted-foreground">No ignored columns set.</span>
                )}
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  value={testIgnoredColumnInput}
                  onChange={(e) => setTestIgnoredColumnInput(e.target.value)}
                  placeholder="Add column title (e.g. Product Description)"
                  className="h-8"
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addIgnoredColumn(testIgnoredColumnInput);
                    setTestIgnoredColumnInput("");
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    addIgnoredColumn(testIgnoredColumnInput);
                    setTestIgnoredColumnInput("");
                  }}
                >
                  Add Title
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                {defaultTestIgnoredColumns.map((title) => {
                  const exists = testIgnoredColumns.some((entry) => entry.toLowerCase() === title.toLowerCase());
                  return (
                    <Button
                      key={title}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={exists}
                      onClick={() => addIgnoredColumn(title)}
                    >
                      {exists ? `Added: ${title}` : `Add ${title}`}
                    </Button>
                  );
                })}
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <Button type="button" size="sm" onClick={saveTestCompareSettings}>
                  <Save className="h-3.5 w-3.5 mr-1" /> Save Test Form Settings
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={resetTestCompareSettings}>
                  Reset Defaults
                </Button>
              </div>

              <div className="border-t border-border pt-3 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Configure order-insensitive comparisons by title and symbol. Example: with symbol <strong>;</strong>,
                  values <strong>A;B</strong> and <strong>B;A</strong> are treated as the same.
                </p>

                <div className="flex flex-wrap gap-2">
                  {testUnorderedRules.map((rule) => (
                    <span
                      key={`${rule.title}::${rule.symbol}`}
                      className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-1 text-xs"
                    >
                      {rule.title} • {rule.symbol}
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => removeUnorderedRule(rule.title, rule.symbol)}
                        aria-label={`Remove ${rule.title} ${rule.symbol}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  {testUnorderedRules.length === 0 && (
                    <span className="text-xs text-muted-foreground">No unordered rules set.</span>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    value={testUnorderedRuleTitleInput}
                    onChange={(e) => setTestUnorderedRuleTitleInput(e.target.value)}
                    placeholder="Column/Data title (e.g. Product Custom Fields)"
                    className="h-8 flex-1"
                  />
                  <Input
                    value={testUnorderedRuleSymbolInput}
                    onChange={(e) => setTestUnorderedRuleSymbolInput(e.target.value)}
                    placeholder="Symbol"
                    className="h-8 w-full sm:w-24"
                    maxLength={4}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      addUnorderedRule(testUnorderedRuleTitleInput, testUnorderedRuleSymbolInput);
                      setTestUnorderedRuleTitleInput("");
                    }}
                  >
                    Add Rule
                  </Button>
                </div>

                <div className="flex flex-wrap gap-2">
                  {defaultTestUnorderedRules.map((rule) => {
                    const exists = testUnorderedRules.some(
                      (entry) => entry.title.toLowerCase() === rule.title.toLowerCase() && entry.symbol === rule.symbol,
                    );
                    const label = `${rule.title} • ${rule.symbol}`;
                    return (
                      <Button
                        key={`${rule.title}::${rule.symbol}`}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={exists}
                        onClick={() => addUnorderedRule(rule.title, rule.symbol)}
                      >
                        {exists ? `Added: ${label}` : `Add ${label}`}
                      </Button>
                    );
                  })}
                </div>
              </div>
            </div>
          </FormSection>
        </div>
      </FormSection>

      {/* Connections & AI Setup */}
      <FormSection title="Connections & AI Setup" defaultOpen={false}>
        <div className="space-y-4">
          <FormSection title="Google Sheets Connection" defaultOpen={false}>
            <div className="space-y-4">
              <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950 dark:border-blue-800 p-4 space-y-2">
                <h4 className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                  📚 Need Help Connecting Your Google Sheet?
                </h4>
                <p className="text-xs text-blue-800 dark:text-blue-200">
                  Follow the complete step-by-step setup guide to securely connect your Google Sheet using a Google
                  Service Account.
                </p>
                <div className="pt-2">
                  <Button type="button" variant="outline" size="sm" asChild className="bg-white dark:bg-gray-900">
                    <a
                      href="https://github.com/bravobraverman1/lighting-style-product-creation/blob/main/GOOGLE_SHEETS_SETUP.md"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-3.5 w-3.5 mr-1" /> View Complete Setup Guide
                    </a>
                  </Button>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-muted bg-muted/50 p-4">
                <h5 className="text-sm font-semibold">Project Check (Important)</h5>
                <p className="text-xs text-muted-foreground">
                  Frontend is hosted on Lovable, but the backend runs on your Supabase Edge Function. Verify your
                  Supabase project configuration before testing the connection.
                </p>
                <p className="text-xs font-semibold text-red-600 dark:text-red-400">
                  ⚠️ Do NOT run Lovable "Security Fixer" for Edge Functions or anything related to cloud/database/AI. It
                  can reroute requests to Lovable services and break your Supabase connection.
                </p>
                <div className="space-y-2 text-sm font-mono">
                  <div className="flex items-start gap-2">
                    <span className="text-xs text-muted-foreground w-32 shrink-0">Supabase URL:</span>
                    <span
                      className={`text-xs break-all ${isValidSupabaseUrl ? "text-foreground" : "text-red-600 dark:text-red-400"}`}
                    >
                      {supabaseUrl || "NOT CONFIGURED"}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-xs text-muted-foreground w-32 shrink-0">Project Ref:</span>
                    <span
                      className={`text-xs ${supabaseProjectRef ? "text-green-600 dark:text-green-400 font-semibold" : "text-red-600 dark:text-red-400"}`}
                    >
                      {supabaseProjectRef ? `✓ Detected: ${supabaseProjectRef}` : "NOT CONFIGURED"}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-xs text-muted-foreground w-32 shrink-0">Publishable Key:</span>
                    <span
                      className={`text-xs font-semibold ${supabaseAnonKey ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                    >
                      {supabaseAnonKey ? "✓ Detected" : "NOT CONFIGURED"}
                    </span>
                  </div>
                </div>
              </div>

              {(!isValidSupabaseUrl || !supabaseAnonKey) && (
                <div className="rounded-lg border-2 border-red-500 bg-red-50 dark:bg-red-950 dark:border-red-800 p-4 space-y-3">
                  <div className="flex items-start gap-2">
                    <span className="text-red-600 dark:text-red-400 text-xl">⚠️</span>
                    <div className="space-y-2 flex-1">
                      <h5 className="text-sm font-bold text-red-900 dark:text-red-100">
                        Environment Variables Not Configured
                      </h5>
                      <p className="text-xs text-red-800 dark:text-red-200">
                        Your Supabase credentials are not set up in Lovable. This is why the Test Connection button is
                        disabled.
                      </p>
                      <div className="text-xs text-red-900 dark:text-red-100 space-y-2 bg-white/50 dark:bg-black/20 p-3 rounded border border-red-300 dark:border-red-700">
                        <p className="font-semibold">Quick Fix (Most Common Issue):</p>
                        <ol className="list-decimal list-inside space-y-1 ml-1">
                          <li>
                            Open{" "}
                            <code className="bg-red-100 dark:bg-red-900 px-1 py-0.5 rounded">
                              src/config/publicEnv.ts
                            </code>{" "}
                            in the codebase
                          </li>
                          <li>
                            Set <code className="bg-red-100 dark:bg-red-900 px-1 py-0.5 rounded">SUPABASE_URL</code> and{" "}
                            <code className="bg-red-100 dark:bg-red-900 px-1 py-0.5 rounded">SUPABASE_ANON_KEY</code> to
                            your actual Supabase project values
                          </li>
                          <li>
                            <strong>Publish/redeploy</strong> the site so changes take effect
                          </li>
                          <li>Hard refresh this page (Ctrl+Shift+R)</li>
                        </ol>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-3 border-l-2 border-primary pl-4">
                <h5 className="text-sm font-semibold">Test Your Connection</h5>
                <p className="text-sm text-muted-foreground">
                  Once you've completed the setup guide above, test that your Google Sheet is connected correctly.
                </p>
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={testSupabaseConnection}
                      disabled={testingConnection || !isValidSupabaseUrl || !supabaseAnonKey}
                    >
                      {testingConnection ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                          Testing Connection...
                        </>
                      ) : (
                        <>
                          <ExternalLink className="h-3.5 w-3.5 mr-2" />
                          Test Connection
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleForceRefreshData}
                      disabled={refreshingSheets}
                    >
                      {refreshingSheets ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                          Refreshing...
                        </>
                      ) : (
                        "Force Refresh Data"
                      )}
                    </Button>
                  </div>

                  <div className="rounded-lg border border-amber-600 bg-amber-50 dark:bg-amber-950 dark:border-amber-800 p-3 space-y-2">
                    <p className="text-xs font-semibold text-amber-900 dark:text-amber-100">
                      🔴 "Cannot Read Secrets" Error?
                    </p>
                    <div className="text-xs text-amber-900 dark:text-amber-100 space-y-1">
                      <p className="font-semibold">
                        This usually means you added secrets AFTER deploying the function.
                      </p>
                      <p className="font-medium">✅ Solution: Redeploy the Edge Function</p>
                      <ol className="list-decimal list-inside space-y-0.5 ml-2">
                        <li>
                          Go to the <strong>Actions</strong> tab in your GitHub repository
                        </li>
                        <li>
                          Click <strong>"Deploy Google Sheets Connection"</strong> in the left sidebar
                        </li>
                        <li>
                          Click <strong>"Run workflow"</strong> dropdown → select "production" → click{" "}
                          <strong>"Run workflow"</strong> button
                        </li>
                        <li>Wait 2-3 minutes for completion</li>
                        <li>
                          Return here and click <strong>"Test Connection"</strong> again
                        </li>
                      </ol>
                      <p className="italic mt-1">
                        Why? Edge Functions load secrets at deployment time only. Adding secrets to an already-running
                        function requires redeployment.
                      </p>
                      <div className="pt-2">
                        <Button type="button" variant="outline" size="sm" asChild className="bg-white dark:bg-gray-900">
                          <a
                            href={`${GITHUB_REPO_URL}/actions/workflows/deploy-google-sheets.yml`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-3 w-3 mr-1" /> Go to GitHub Actions Workflow
                          </a>
                        </Button>
                      </div>
                    </div>
                    <div className="pt-2 border-t border-amber-200 dark:border-amber-700">
                      <p className="text-xs font-semibold text-amber-900 dark:text-amber-100">Other Common Errors:</p>
                      <ul className="text-xs text-amber-800 dark:text-amber-200 mt-1 space-y-0.5 list-disc list-inside">
                        <li>
                          <strong>Edge Function not found (404):</strong> Function not deployed yet - see setup guide
                          STEP 3
                        </li>
                        <li>
                          <strong>Access denied (403):</strong> Google Sheet not shared with service account - see setup
                          guide STEP 2
                        </li>
                      </ul>
                    </div>
                  </div>

                  <div className="rounded-lg border border-green-600 bg-green-50 dark:bg-green-950 dark:border-green-800 p-3">
                    <p className="text-xs font-semibold text-green-900 dark:text-green-100">
                      ✅ Successful test shows: "Connected" with your product and category counts.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </FormSection>

          <FormSection title="Gemini AI Setup" defaultOpen={false}>
            <GeminiSetupSection
              supabaseUrl={supabaseUrl}
              supabaseAnonKey={supabaseAnonKey}
              isValidSupabaseUrl={isValidSupabaseUrl}
            />
          </FormSection>
        </div>
      </FormSection>
    </div>
  );
};

export default Admin;
