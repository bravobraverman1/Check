import React, { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";

const formAdminMocks = vi.hoisted(() => ({
  toastMock: vi.fn(),
  submitProductMock: vi.fn(async () => ({ success: true })),
  syncGoogleSheetQueriesMock: vi.fn(async () => undefined),
  broadcastConfigChangeMock: vi.fn(),
  updateGeminiConfigMock: vi.fn(),
  saveSharedDockFormSnapshotMock: vi.fn(async () => undefined),
  getSharedDockFormSnapshotMock: vi.fn(async () => ({ snapshot: null })),
  removeGlobalPendingDockSubmitMock: vi.fn(async () => true),
  persistGlobalPendingDockSubmitMock: vi.fn(async () => true),
  persistPendingDockSubmitMock: vi.fn(() => true),
  removePendingDockSubmitMock: vi.fn(),
  fetchPropertiesMock: vi.fn(async () => ({
    properties: [
      { key: "colour1", name: "Colour #1", inputType: "dropdown", required: true },
      { key: "notes", name: "Notes", inputType: "text", required: false },
    ],
    legalValues: [
      { propertyName: "Colour #1", allowedValue: "WHITE" },
    ],
    masterLookup: [
      { defaultName: "Default", categoryPath: "Lights/Downlights", nameStructure: "A+B", nameExample: "X" },
    ],
    masterDefaults: [
      { name: "Default", allowedProperties: ["Colour #1"] },
    ],
    existingTitles: ["Existing Duplicate Title"],
  })),
  fetchRecentSubmissionsMock: vi.fn(async () => []),
  getLastDockTitleMapMock: vi.fn(() => ({})),
  invokeGoogleSheetsFunctionMock: vi.fn(async () => ({
    data: { useDefaults: false, products: [{ sku: "SKU-1" }], categoryPathCount: 2 },
    error: null,
  })),
}));

export { formAdminMocks };

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: formAdminMocks.toastMock }),
}));

vi.mock("@/components/FormSection", () => ({
  FormSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

vi.mock("@/components/SkuSelector", () => ({
  SkuSelector: ({
    onSelect,
    value,
  }: {
    onSelect: (sku: string, brand: string) => void;
    value?: string;
  }) => (
    <button type="button" onClick={() => onSelect("SKU-1", "Brand A")}>
      {value || "Pick SKU"}
    </button>
  ),
}));

vi.mock("@/components/CategoryTreeDropdown", () => ({
  CategoryTreeDropdown: ({
    onSelectedChange,
    onMainChange,
  }: {
    onSelectedChange: (v: string[]) => void;
    onMainChange: (v: string) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onSelectedChange(["Lights/Downlights"]);
        onMainChange("Lights/Downlights");
      }}
    >
      Pick Category
    </button>
  ),
}));

vi.mock("@/components/DynamicImageInputs", () => ({
  DynamicImageInputs: ({ onChange }: { onChange: (v: string[]) => void }) => (
    <button type="button" onClick={() => onChange(["https://example.com/a.jpg"])}>Add Image</button>
  ),
}));

vi.mock("@/components/DynamicSpecifications", () => ({
  DynamicSpecifications: ({
    onMandatoryKeysChange,
    onChange,
    mandatoryErrors,
  }: {
    onMandatoryKeysChange?: (keys: string[]) => void;
    onChange: (key: string, value: string) => void;
    mandatoryErrors?: Set<string>;
  }) => {
    useEffect(() => {
      onMandatoryKeysChange?.(["colour1"]);
    }, [onMandatoryKeysChange]);

    return (
      <div>
        <button type="button" onClick={() => onChange("colour1", "WHITE")}>Fill Mandatory Filter</button>
        {mandatoryErrors?.has("colour1") ? <div>Mandatory Missing</div> : null}
      </div>
    );
  },
}));

vi.mock("@/components/PdfViewer", () => ({
  PdfViewer: () => <div>PdfViewer Stub</div>,
}));

vi.mock("@/components/AiProgressBlock", () => ({
  AiProgressBlock: () => <div>AiProgressBlock Stub</div>,
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/context/PdfFilesContext", () => ({
  usePdfFiles: () => {
    const [datasheetFile, setDatasheetFile] = useState<File | null>(null);
    const [websitePdfFile, setWebsitePdfFile] = useState<File | null>(null);
    return {
      datasheetFile,
      setDatasheetFile,
      websitePdfFile,
      setWebsitePdfFile,
    };
  },
}));

vi.mock("@/lib/sharedDockFormSnapshots", () => ({
  saveSharedDockFormSnapshot: formAdminMocks.saveSharedDockFormSnapshotMock,
  getSharedDockFormSnapshot: formAdminMocks.getSharedDockFormSnapshotMock,
}));

vi.mock("@/hooks/useAiJob", () => ({
  useAiJob: () => ({
    status: "idle",
    progress: 0,
    chunksDone: 0,
    chunksTotal: 0,
    chunksError: 0,
    error: "",
    jobId: null,
    latencyMs: null,
    modelUsed: null,
    result: null,
    statusPayload: null,
    cancelJob: vi.fn(),
    reset: vi.fn(),
    startJob: vi.fn(),
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      })),
      startAutoRefresh: vi.fn(),
      stopAutoRefresh: vi.fn(),
    },
    functions: {
      invoke: vi.fn(async () => ({ data: null, error: null })),
    },
    storage: {
      from: () => ({
        list: vi.fn(async () => ({ data: [] })),
        download: vi.fn(async () => ({ data: null })),
        upload: vi.fn(async () => ({ data: null, error: null })),
        remove: vi.fn(async () => ({ data: null, error: null })),
      }),
    },
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      })),
      startAutoRefresh: vi.fn(),
      stopAutoRefresh: vi.fn(),
    },
    functions: {
      invoke: vi.fn(async () => ({ data: null, error: null })),
    },
    storage: {
      from: () => ({
        list: vi.fn(async () => ({ data: [] })),
        download: vi.fn(async () => ({ data: null })),
        upload: vi.fn(async () => ({ data: null, error: null })),
        remove: vi.fn(async () => ({ data: null, error: null })),
      }),
    },
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    })),
    removeChannel: vi.fn(),
  })),
}));

vi.mock("@/lib/api", () => ({
  fetchSkus: vi.fn(async () => [
    { sku: "SKU-1", brand: "Brand A", price: "73.00", exampleTitle: "Example Title" },
  ]),
  fetchSkuSheetDetails: vi.fn(async () => ({ brand: "Brand A", price: "73.00", visibility: "1" })),
  peekNextMpnDirect: vi.fn(async () => "57388"),
  resolveFormMpnStateDirect: vi.fn(async (_draftId: string, _sku: string, source: "View" | "Send By Email" | "Download") => ({
    mpn: "57388",
    attachmentState: source === "View" ? "generated" : "attached",
    transition: source === "View" ? "generated_new" : "generated_and_attached",
  })),
  logFormMpnSkuChangeDirect: vi.fn(async () => ({
    success: true,
    statusMessage: "MPN SKU change logged",
  })),
  releaseFormGeneratedMpnDirect: vi.fn(async () => undefined),
  fetchCategories: vi.fn(async () => []),
  fetchCategoriesWithSource: vi.fn(async () => ({ categories: [], source: "google-sheets" })),
  fetchProperties: formAdminMocks.fetchPropertiesMock,
  fetchRecentSubmissions: formAdminMocks.fetchRecentSubmissionsMock,
  submitProduct: formAdminMocks.submitProductMock,
  sendProductByEmail: vi.fn(async () => ({ success: true, queued: true })),
  downloadProductCsv: vi.fn(async () => ({
    success: true,
    filename: "SKU-1.csv",
    csvText: "SKU,Brand\nSKU-1,Brand A\n",
  })),
  markSkuComplete: vi.fn(async () => ({ success: true })),
  addLegalValue: vi.fn(async () => undefined),
  updateCategories: vi.fn(async () => undefined),
}));

vi.mock("@/lib/supabaseGoogleSheets", () => ({
  checkSkuInLoadingDock: vi.fn(async () => false),
  checkSkuStatusFresh: vi.fn(async () => ({ status: "TO_DO", recentSubmit: false })),
  checkDockRowStatus: vi.fn(async () => ({ success: true, existsInDock: true, pending: false, actionable: true })),
  getLastFormDataMap: vi.fn(() => ({})),
  getLastDockTitleMap: formAdminMocks.getLastDockTitleMapMock,
  isEdgeFunctionTimeoutErrorMessage: vi.fn(() => false),
  persistGlobalPendingDockSubmit: formAdminMocks.persistGlobalPendingDockSubmitMock,
  removeGlobalPendingDockSubmit: formAdminMocks.removeGlobalPendingDockSubmitMock,
  writeAiLogEntry: vi.fn(async () => undefined),
  invokeGoogleSheetsFunction: formAdminMocks.invokeGoogleSheetsFunctionMock,
}));

vi.mock("@/lib/querySync", () => ({
  syncGoogleSheetQueries: formAdminMocks.syncGoogleSheetQueriesMock,
}));

vi.mock("@/lib/loadingDockPending", () => ({
  persistPendingDockSubmit: formAdminMocks.persistPendingDockSubmitMock,
  removePendingDockSubmit: formAdminMocks.removePendingDockSubmitMock,
}));

vi.mock("@/lib/bucketAllocation", () => ({
  withBucket: vi.fn(async (_label: string, fn: (bucket: string) => Promise<unknown>) => fn("bucket-a")),
  withCompareBucket: vi.fn(async (_label: string, fn: (bucket: string) => Promise<unknown>) => fn("bucket-b")),
  allocateProductBucket: vi.fn(async () => ({ bucket: "bucket-a" })),
  uploadFilesToBucket: vi.fn(async () => []),
  uploadJsonToFormImportBucket: vi.fn(async () => ({
    bucket: "document-uploads-form-json",
    path: "form-imports/mock.json",
  })),
  cleanBucket: vi.fn(async () => undefined),
  releaseBucketLock: vi.fn(async () => undefined),
}));

vi.mock("@/lib/runAiAction", () => ({
  runAiAction: vi.fn(async () => ({
    success: true,
    result: "",
    usage: { inputTokens: 0, outputTokens: 0 },
  })),
}));

vi.mock("@/lib/parseGeminiSections", () => ({
  extractGeminiLeadingText: vi.fn(() => ""),
  hasGeminiSectionHeaders: vi.fn(() => false),
  parseGeminiSections: vi.fn(() => ({})),
  parseFilterProposals: vi.fn(() => []),
}));

vi.mock("@/lib/pdfSourceValidation", () => ({
  assessPdfRelationship: vi.fn(() => null),
  assessProductDataSupport: vi.fn(() => null),
  extractPdfPlainText: vi.fn(async () => ""),
}));

vi.mock("@/lib/filterDimensionFormatting", () => ({
  formatDimensionFilterValueForCsv: vi.fn((value: string) => value),
  normalizeDimensionFilterValueForStorage: vi.fn((_key: string, value: string) => value),
}));

vi.mock("@/lib/twoPdfPostProcess", () => ({
  extractProductDataSectionFromGenerateResponse: vi.fn(() => ""),
  reconcileTwoPdfProductDataAndConflicts: vi.fn(() => ({
    productData: "",
    conflicts: [],
  })),
  refineTwoPdfProductData: vi.fn(() => ""),
}));

vi.mock("@/lib/pdfCompareNormalization", () => ({
  normalizeComparisonRows: vi.fn((rows: unknown[]) => rows),
  isComparePlaceholderValue: vi.fn(() => false),
}));

vi.mock("@/lib/unitNormalization", () => ({
  extractUnitFromPropertyName: vi.fn(() => ""),
  formatNumericForInput: vi.fn((value: string | number) => String(value ?? "")),
  parseNumericValueForExpectedUnit: vi.fn(() => null),
}));

vi.mock("@/lib/aiRoutingConfig", () => ({
  getAiActionRouting: vi.fn(() => null),
  getDefaultAiRoutingConfig: vi.fn(() => ({})),
}));

vi.mock("@/lib/aiCollisionTuningConfig", () => ({
  getAiCollisionTuningConfig: vi.fn(() => ({})),
}));

vi.mock("@/lib/parseTitleDescriptionJson", () => ({
  parseTitleDescriptionJson: vi.fn(() => null),
}));

vi.mock("@/lib/normalizeGeneratedTitleCase", () => ({
  normalizeGeneratedTitleCase: vi.fn((value: string) => value),
}));

vi.mock("@/lib/aiCompareKeys", () => ({
  COMPARISON_ROW_KEYS: [],
  SUPPLIER_INVENTORY_KEYS: [],
  LS_INVENTORY_KEYS: [],
}));

vi.mock("@/lib/missingValueMarkers", () => ({
  isMissingValue: vi.fn((value: string) => /missing/i.test(value)),
  isMissingMarker: vi.fn((value: string) => /^MISSING\*{3}(?:\s*\([^)]*\))?$/i.test(value.trim())),
  hasMissingMarkerSubstring: vi.fn((value: string) => /MISSING\*{3}/i.test(value)),
}));

vi.mock("@/lib/promptVariablesCache", () => ({
  loadPromptVariables: vi.fn(async () => []),
}));

vi.mock("@/lib/aiPromptCandidateSelection", () => ({
  selectFirstCompatibleActivePrompt: vi.fn(() => null),
}));

vi.mock("@/lib/aiLogging", () => ({
  trackAiGenerated: vi.fn(),
  clearAiTracking: vi.fn(),
  buildAiLogEntry: vi.fn(() => ({})),
  buildFilterLogString: vi.fn(() => ""),
  extractFilterKeys: vi.fn(() => []),
  getTrackedFilters: vi.fn(() => []),
  computeWordDiff: vi.fn(() => []),
  computeFilterDiff: vi.fn(() => []),
  serializeDiff: vi.fn(() => ""),
}));

vi.mock("@/lib/resolvePromptVariables", () => ({
  getPromptVariablesInUse: vi.fn(() => []),
  resolvePromptVariables: vi.fn(() => ({ output: "", unresolved: [] })),
  normalizePromptVariableBindingType: vi.fn((value: string) => value),
  BINDING_TYPES: [],
}));

vi.mock("@/lib/configSync", () => ({
  broadcastConfigChange: formAdminMocks.broadcastConfigChangeMock,
}));

vi.mock("@/config", () => ({
  config: {
    STATUS_TO_DO: "TO_DO",
    INSTRUCTIONS_PDF_URL: "",
    DRIVE_CSV_FOLDER_ID: "",
  },
  DEFAULT_SHEET_TABS: [
    { key: "CATEGORIES_TAB", label: "Categories" },
    { key: "EXISTING_TAB", label: "Existing Products" },
  ],
  getSheetTabName: vi.fn((key: string) => key),
  setSheetTabName: vi.fn(),
  setConfigValue: vi.fn(),
}));

vi.mock("@/config/publicEnv", () => ({
  SUPABASE_URL: "https://demo.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_FUNCTIONS_URL: "https://demo.supabase.co/functions/v1",
}));

vi.mock("@/lib/geminiConfig", () => ({
  getGeminiConfig: () => ({ enabled: true, model: "gemini-2.0-flash" }),
  updateGeminiConfig: formAdminMocks.updateGeminiConfigMock,
  GEMINI_MODELS: [
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", description: "Fast" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", description: "Accurate" },
  ],
  DEFAULT_GEMINI_MODEL: "gemini-2.0-flash",
}));

vi.mock("@/components/CompareDatasheets", () => ({
  CompareDatasheets: () => <div>CompareDatasheets Stub</div>,
}));

vi.mock("@/components/AiPromptEditor", () => ({
  AiPromptEditor: ({ heading }: { heading: string }) => <div>{heading}</div>,
}));

vi.mock("@/components/BillingPanel", () => ({
  BillingPanel: () => <div>BillingPanel Stub</div>,
}));

vi.mock("@/components/AiJobsDebugPanel", () => ({
  AiJobsDebugPanel: () => <div>AiJobsDebugPanel Stub</div>,
}));

vi.mock("@/components/GeminiSetupSection", () => ({
  GeminiSetupSection: () => <div>GeminiSetupSection Stub</div>,
}));

vi.mock("@/components/AiCollisionTuningSection", () => ({
  AiCollisionTuningSection: () => <div>AiCollisionTuningSection Stub</div>,
}));

vi.mock("@/components/AiRoutingOptionsSection", () => ({
  AiRoutingOptionsSection: () => <div>AiRoutingOptionsSection Stub</div>,
}));

vi.mock("@/components/AiInstructionsConstants", () => ({
  AiInstructionsConstants: () => <div>AiInstructionsConstants Stub</div>,
}));

vi.mock("@/components/MpnPanel", () => ({
  MpnPanel: () => <div>MpnPanel Stub</div>,
}));

export function ensureStorageApis() {
  const createStorage = () => {
    const store = new Map<string, string>();
    return {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
      key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
      get length() {
        return store.size;
      },
    };
  };

  const local = globalThis.localStorage as Storage | undefined;
  if (!local || typeof local.setItem !== "function") {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: createStorage(),
    });
  }

  const session = globalThis.sessionStorage as Storage | undefined;
  if (!session || typeof session.setItem !== "function") {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      writable: true,
      value: createStorage(),
    });
  }

  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      writable: true,
      value: globalThis.localStorage,
    });
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      writable: true,
      value: globalThis.sessionStorage,
    });
  }

  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:test-file"),
    });
  }

  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => undefined),
    });
  }

  if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
    Object.defineProperty(Blob.prototype, "arrayBuffer", {
      configurable: true,
      writable: true,
      value: vi.fn(async () => new ArrayBuffer(0)),
    });
  }

  if (typeof globalThis.ResizeObserver !== "function") {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: ResizeObserverMock,
    });
  }

  if (typeof window !== "undefined" && typeof window.ResizeObserver !== "function") {
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: globalThis.ResizeObserver,
    });
  }

  if (typeof HTMLAnchorElement !== "undefined") {
    Object.defineProperty(HTMLAnchorElement.prototype, "click", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
}

export function clearTestState() {
  ensureStorageApis();
  vi.clearAllMocks();
  formAdminMocks.submitProductMock.mockReset();
  formAdminMocks.submitProductMock.mockImplementation(async () => ({ success: true }));
  formAdminMocks.syncGoogleSheetQueriesMock.mockReset();
  formAdminMocks.syncGoogleSheetQueriesMock.mockImplementation(async () => undefined);
  formAdminMocks.broadcastConfigChangeMock.mockReset();
  formAdminMocks.updateGeminiConfigMock.mockReset();
  formAdminMocks.saveSharedDockFormSnapshotMock.mockReset();
  formAdminMocks.saveSharedDockFormSnapshotMock.mockImplementation(async () => undefined);
  formAdminMocks.getSharedDockFormSnapshotMock.mockReset();
  formAdminMocks.getSharedDockFormSnapshotMock.mockImplementation(async () => ({ snapshot: null }));
  formAdminMocks.removeGlobalPendingDockSubmitMock.mockReset();
  formAdminMocks.removeGlobalPendingDockSubmitMock.mockImplementation(async () => true);
  formAdminMocks.persistGlobalPendingDockSubmitMock.mockReset();
  formAdminMocks.persistGlobalPendingDockSubmitMock.mockImplementation(async () => true);
  formAdminMocks.persistPendingDockSubmitMock.mockReset();
  formAdminMocks.persistPendingDockSubmitMock.mockImplementation(() => true);
  formAdminMocks.removePendingDockSubmitMock.mockReset();
  formAdminMocks.removePendingDockSubmitMock.mockImplementation(() => undefined);
  formAdminMocks.fetchPropertiesMock.mockReset();
  formAdminMocks.fetchPropertiesMock.mockImplementation(async () => ({
    properties: [
      { key: "colour1", name: "Colour #1", inputType: "dropdown", required: true },
      { key: "notes", name: "Notes", inputType: "text", required: false },
    ],
    legalValues: [
      { propertyName: "Colour #1", allowedValue: "WHITE" },
    ],
    masterLookup: [
      { defaultName: "Default", categoryPath: "Lights/Downlights", nameStructure: "A+B", nameExample: "X" },
    ],
    masterDefaults: [
      { name: "Default", allowedProperties: ["Colour #1"] },
    ],
    existingTitles: ["Existing Duplicate Title"],
  }));
  formAdminMocks.fetchRecentSubmissionsMock.mockReset();
  formAdminMocks.fetchRecentSubmissionsMock.mockImplementation(async () => []);
  formAdminMocks.getLastDockTitleMapMock.mockReset();
  formAdminMocks.getLastDockTitleMapMock.mockImplementation(() => ({}));
  formAdminMocks.invokeGoogleSheetsFunctionMock.mockReset();
  formAdminMocks.invokeGoogleSheetsFunctionMock.mockImplementation(async () => ({
    data: { useDefaults: false, products: [{ sku: "SKU-1" }], categoryPathCount: 2 },
    error: null,
  }));
  if (typeof localStorage?.clear === "function") localStorage.clear();
  if (typeof sessionStorage?.clear === "function") sessionStorage.clear();
}

export function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

export { renderToStaticMarkup };
