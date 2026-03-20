import { beforeEach, describe, expect, it, vi } from "vitest";

const configStore = new Map<string, string>();

vi.mock("@/config", () => ({
  getConfigValue: (key: string, fallback = "") => configStore.get(key) ?? fallback,
  setConfigValue: (key: string, value: string) => {
    configStore.set(key, value);
  },
}));

import {
  getAiRoutingConfig,
  getDefaultAiRoutingConfig,
  setAiRoutingConfig,
} from "@/lib/aiRoutingConfig";

describe("aiRoutingConfig defaults and overrides", () => {
  beforeEach(() => {
    configStore.clear();
  });

  it("uses data-only prompt defaults for single PDF generation", () => {
    const defaults = getDefaultAiRoutingConfig();
    expect(defaults.product_generate_two_pdfs.promptCandidates[0]).toBe("product_data");
    expect(defaults.product_generate_datasheet_only.promptCandidates).toEqual(["data_title_datasheet", "product_data"]);
    expect(defaults.product_generate_webpage_only.promptCandidates).toEqual(["data_title_webpage", "product_data"]);
  });

  it("keeps technical/marketing prompts mapped by default", () => {
    const defaults = getDefaultAiRoutingConfig();
    expect(defaults.product_generate_description_technical.promptCandidates[0]).toBe("technical");
    expect(defaults.product_generate_description_marketing.promptCandidates[0]).toBe("marketing");
  });

  it("accepts user-defined prompt candidates from stored routing config", () => {
    const custom = getDefaultAiRoutingConfig();
    custom.product_generate_datasheet_only.promptCandidates = ["data_title_datasheet"];
    custom.product_generate_webpage_only.promptCandidates = ["data_title_webpage"];
    custom.product_generate_description_technical.promptCandidates = ["technical"];
    custom.product_generate_description_marketing.promptCandidates = ["marketing"];

    setAiRoutingConfig(custom);
    const loaded = getAiRoutingConfig();

    expect(loaded.product_generate_datasheet_only.promptCandidates).toEqual(["data_title_datasheet"]);
    expect(loaded.product_generate_webpage_only.promptCandidates).toEqual(["data_title_webpage"]);
    expect(loaded.product_generate_description_technical.promptCandidates[0]).toBe("technical");
    expect(loaded.product_generate_description_marketing.promptCandidates[0]).toBe("marketing");
  });

  it("preserves stored single-pdf prompt ordering when candidates are valid", () => {
    const custom = getDefaultAiRoutingConfig();
    custom.product_generate_datasheet_only.promptCandidates = ["data_title_datasheet", "product_data"];
    custom.product_generate_webpage_only.promptCandidates = ["data_title_webpage", "product_data"];

    setAiRoutingConfig(custom);
    const loaded = getAiRoutingConfig();

    expect(loaded.product_generate_datasheet_only.promptCandidates).toEqual(["data_title_datasheet", "product_data"]);
    expect(loaded.product_generate_webpage_only.promptCandidates).toEqual(["data_title_webpage", "product_data"]);
  });

  it("drops cross-pipeline prompt candidates and instruction slots that do not belong to an action", () => {
    const custom = getDefaultAiRoutingConfig();
    custom.product_generate_datasheet_only.promptCandidates = ["technical", "compare_sheets", "data_title_datasheet"];
    custom.product_generate_datasheet_only.instructionSlots = [
      "ai-compare-datasheets",
      "prod-creation-single-pdf",
    ];
    custom.compare_two_datasheets.promptCandidates = ["technical", "compare_sheets", "product_data"];
    custom.compare_two_datasheets.instructionSlots = ["prod-creation-two-pdf", "ai-compare-datasheets"];

    setAiRoutingConfig(custom);
    const loaded = getAiRoutingConfig();

    expect(loaded.product_generate_datasheet_only.promptCandidates).toEqual(["data_title_datasheet"]);
    expect(loaded.product_generate_datasheet_only.instructionSlots).toEqual([
      "prod-creation-datasheet-only",
      "prod-creation-single-pdf",
    ]);
    expect(loaded.compare_two_datasheets.promptCandidates).toEqual(["compare_sheets"]);
    expect(loaded.compare_two_datasheets.instructionSlots).toEqual(["ai-compare-datasheets"]);
  });
});
