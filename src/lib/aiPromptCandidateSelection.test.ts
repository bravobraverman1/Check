import { beforeEach, describe, expect, it, vi } from "vitest";

const promptStore = new Map<string, string | null>();
const variableStore = new Map<string, Array<{ name: string; bindingType: string }>>();

vi.mock("@/lib/aiPromptCache", () => ({
  getActivePromptContentNoCache: async (promptType: string) => promptStore.get(promptType) ?? null,
}));

vi.mock("@/lib/promptVariablesCache", () => ({
  loadPromptVariables: async (promptType: string) => variableStore.get(promptType) ?? [],
}));

vi.mock("@/lib/resolvePromptVariables", () => ({
  getPromptVariablesInUse: ({ variables }: { variables: Array<{ name: string; bindingType: string }> }) => variables,
  resolvePromptVariables: (
    promptConfig: { variables: Array<{ name: string; bindingType: string }> },
    runtimeContext: {
      datasheetUpload?: unknown;
      websiteUpload?: unknown;
      compareSupplierPdf?: unknown;
      compareLsPdf?: unknown;
    } | undefined,
  ) => {
    const errors: string[] = [];

    for (const variable of promptConfig.variables || []) {
      switch (variable.bindingType) {
        case "supplier_datasheet_pdf":
          if (!runtimeContext?.datasheetUpload) errors.push("Missing required: Supplier Datasheet PDF (Form)");
          break;
        case "supplier_website_pdf":
          if (!runtimeContext?.websiteUpload) errors.push("Missing required: Supplier Website PDF (Form)");
          break;
        case "compare_supplier_pdf":
          if (!runtimeContext?.compareSupplierPdf) errors.push("Missing required: Compare: Supplier Datasheet PDF");
          break;
        case "compare_ls_pdf":
          if (!runtimeContext?.compareLsPdf) errors.push("Missing required: Compare: LS Datasheet PDF");
          break;
        default:
          break;
      }
    }

    return {
      validationErrors: errors,
      finalPrompt: "",
      debugResolved: [],
      files: [],
    };
  },
}));

import { selectFirstCompatibleActivePrompt } from "@/lib/aiPromptCandidateSelection";

describe("selectFirstCompatibleActivePrompt", () => {
  beforeEach(() => {
    promptStore.clear();
    variableStore.clear();
  });

  it("skips a datasheet candidate that incorrectly requires website PDF and falls back to the next valid prompt", async () => {
    promptStore.set("data_title_datasheet", "Prompt using {{WEBSITE_PDF}}");
    variableStore.set("data_title_datasheet", [{ name: "WEBSITE_PDF", bindingType: "supplier_website_pdf" }]);

    promptStore.set("product_data", "Prompt using {{DATASHEET_PDF}}");
    variableStore.set("product_data", [{ name: "DATASHEET_PDF", bindingType: "supplier_datasheet_pdf" }]);

    const selection = await selectFirstCompatibleActivePrompt(
      ["data_title_datasheet", "product_data"],
      {
        datasheetUpload: { label: "datasheet", bucket: "test", path: "test.pdf", filename: "test.pdf" },
        websiteUpload: null,
      },
    );

    expect(selection).toEqual({
      prompt: "Prompt using {{DATASHEET_PDF}}",
      promptType: "product_data",
    });
  });

  it("keeps the datasheet-only prompt when it matches the uploaded source", async () => {
    promptStore.set("data_title_datasheet", "Prompt using {{DATASHEET_PDF}}");
    variableStore.set("data_title_datasheet", [{ name: "DATASHEET_PDF", bindingType: "supplier_datasheet_pdf" }]);

    const selection = await selectFirstCompatibleActivePrompt(
      ["data_title_datasheet", "product_data"],
      {
        datasheetUpload: { label: "datasheet", bucket: "test", path: "test.pdf", filename: "test.pdf" },
        websiteUpload: null,
      },
    );

    expect(selection).toEqual({
      prompt: "Prompt using {{DATASHEET_PDF}}",
      promptType: "data_title_datasheet",
    });
  });
});
