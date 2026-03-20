import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeEdgeFunctionMock = vi.fn();
const storageState = new Map<string, string>();

function installStorageShim() {
  const storage = {
    getItem: (key: string) => storageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageState.set(key, value);
    },
    removeItem: (key: string) => {
      storageState.delete(key);
    },
    clear: () => {
      storageState.clear();
    },
  };

  vi.stubGlobal("localStorage", storage);
}

async function loadModule() {
  vi.resetModules();
  vi.doMock("@/lib/edgeAuth", () => ({
    invokeEdgeFunction: invokeEdgeFunctionMock,
  }));
  return import("@/lib/promptVariablesCache");
}

describe("loadPromptVariables", () => {
  beforeEach(() => {
    installStorageShim();
    localStorage.clear();
    invokeEdgeFunctionMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/edgeAuth");
    vi.resetModules();
  });

  it("prefers the latest edge-loaded variables over stale local storage", async () => {
    localStorage.setItem(
      "ai-prompt-vars-product_data",
      JSON.stringify([{ name: "OLD_FILTER_CONTEXT", bindingType: "form_filter_context", required: true }]),
    );
    invokeEdgeFunctionMock.mockResolvedValue({
      data: {
        variables: [{ name: "FILTER_CONTEXT", bindingType: "form_filter_context", required: true }],
      },
      error: null,
    });

    const { loadPromptVariables } = await loadModule();
    const variables = await loadPromptVariables("product_data");

    expect(variables).toEqual([
      { name: "FILTER_CONTEXT", bindingType: "form_filter_context", required: true },
    ]);
    expect(JSON.parse(localStorage.getItem("ai-prompt-vars-product_data") || "[]")).toEqual(variables);
  });

  it("clears stale cached variables when the edge source of truth returns none", async () => {
    localStorage.setItem(
      "ai-prompt-vars-product_data",
      JSON.stringify([{ name: "FILTER_CONTEXT", bindingType: "form_filter_context", required: true }]),
    );
    invokeEdgeFunctionMock.mockResolvedValue({
      data: { variables: [] },
      error: null,
    });

    const { loadPromptVariables } = await loadModule();
    const variables = await loadPromptVariables("product_data");

    expect(variables).toEqual([]);
    expect(localStorage.getItem("ai-prompt-vars-product_data")).toBeNull();
  });
});
