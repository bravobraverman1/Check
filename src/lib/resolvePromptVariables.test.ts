import { describe, expect, it } from "vitest";
import { resolvePromptVariables, type PromptConfig } from "@/lib/resolvePromptVariables";

describe("resolvePromptVariables", () => {
  it("does not fail required validation for variables not referenced in prompt content", () => {
    const config: PromptConfig = {
      promptType: "test",
      promptName: "test",
      activeVersionContent: "Generate output using only this text.",
      variables: [
        { name: "FILTER_CONTEXT", bindingType: "form_filter_context", required: true },
      ],
    };

    const result = resolvePromptVariables(config, {});
    expect(result.validationErrors).toEqual([]);
  });

  it("fails required validation when referenced placeholder is missing", () => {
    const config: PromptConfig = {
      promptType: "test",
      promptName: "test",
      activeVersionContent: "Use this context: {{MY_SKU}}",
      variables: [
        { name: "MY_SKU", bindingType: "form_sku", required: true },
      ],
    };

    const result = resolvePromptVariables(config, {});
    expect(result.validationErrors).toEqual(["Missing required: SKU (select a product first)"]);
  });

  it("does not fail validation for empty filter context (no filters for category)", () => {
    const config: PromptConfig = {
      promptType: "test",
      promptName: "test",
      activeVersionContent: "Filters: {{FILTER_CONTEXT}}",
      variables: [
        { name: "FILTER_CONTEXT", bindingType: "form_filter_context", required: true },
      ],
    };

    const result = resolvePromptVariables(config, {});
    expect(result.validationErrors).toEqual([]);
  });

  it("auto-resolves legacy FILTER_CONTEXT placeholder even when prompt variables are not declared", () => {
    const config: PromptConfig = {
      promptType: "product_data",
      promptName: "product_data",
      activeVersionContent: "Fill in the filters {{FILTER_CONTEXT}}\nFinal line",
      variables: [],
    };

    const result = resolvePromptVariables(config, {
      formFilterContext: "COLOUR (mandatory)\nTYPE (mandatory)",
    });

    expect(result.validationErrors).toEqual([]);
    expect(result.finalPrompt).toContain("COLOUR (mandatory)");
    expect(result.finalPrompt).not.toContain("{{FILTER_CONTEXT}}");
  });

  it("does not fail validation for missing category naming helpers", () => {
    const config: PromptConfig = {
      promptType: "test",
      promptName: "test",
      activeVersionContent: "Name Example: {{CATEGORY_NAME_EXAMPLE}}",
      variables: [
        { name: "CATEGORY_NAME_EXAMPLE", bindingType: "category_name_example", required: true },
      ],
    };

    const result = resolvePromptVariables(config, {});
    expect(result.validationErrors).toEqual([]);
    expect(result.finalPrompt).not.toContain("{{CATEGORY_NAME_EXAMPLE}}");
  });

  it("treats compare optional SKU as optional and prunes the line when empty", () => {
    const config: PromptConfig = {
      promptType: "compare_sheets",
      promptName: "compare_sheets",
      activeVersionContent: "Compare context\nSKU: {{COMPARE_SKU}}\nNext line",
      variables: [
        { name: "COMPARE_SKU", bindingType: "compare_optional_sku", required: true },
      ],
    };

    const missing = resolvePromptVariables(config, {});
    expect(missing.validationErrors).toEqual([]);
    expect(missing.finalPrompt).toBe("Compare context\nNext line");

    const present = resolvePromptVariables(config, { compareOptionalSku: "ABC-123" });
    expect(present.validationErrors).toEqual([]);
    expect(present.finalPrompt).toContain("SKU: ABC-123");
  });

  it("maps legacy sku binding types to form_sku for backward compatibility", () => {
    const config: PromptConfig = {
      promptType: "technical",
      promptName: "technical",
      activeVersionContent: "SKU: {{SKU}}",
      variables: [
        { name: "SKU", bindingType: "sku" as never, required: true },
      ],
    };

    const missing = resolvePromptVariables(config, {});
    expect(missing.validationErrors).toEqual(["Missing required: SKU (select a product first)"]);

    const present = resolvePromptVariables(config, { formSku: "TEST-SKU-123" });
    expect(present.validationErrors).toEqual([]);
    expect(present.finalPrompt).toContain("SKU: TEST-SKU-123");
  });

  it("infers compare SKU binding from variable name when binding type is unknown", () => {
    const config: PromptConfig = {
      promptType: "compare_sheets",
      promptName: "compare_sheets",
      activeVersionContent: "SKU: {{SKU}}",
      variables: [
        { name: "SKU", bindingType: "unknown_binding" as never, required: true },
      ],
    };

    const missing = resolvePromptVariables(config, {});
    expect(missing.validationErrors).toEqual([]);
    expect(missing.finalPrompt).toBe("");

    const present = resolvePromptVariables(config, { compareOptionalSku: "TEST-SKU-123" });
    expect(present.validationErrors).toEqual([]);
    expect(present.finalPrompt).toContain("TEST-SKU-123");
  });

  it("treats compare_sheets form_sku binding as optional compare SKU for backward compatibility", () => {
    const config: PromptConfig = {
      promptType: "compare_sheets",
      promptName: "compare_sheets",
      activeVersionContent: "Compare\nSKU: {{SKU}}\nNext line",
      variables: [
        { name: "SKU", bindingType: "form_sku", required: true },
      ],
    };

    const missing = resolvePromptVariables(config, {});
    expect(missing.validationErrors).toEqual([]);
    expect(missing.finalPrompt).toBe("Compare\nNext line");

    const present = resolvePromptVariables(config, { compareOptionalSku: "OPTIONAL-SKU-1" });
    expect(present.validationErrors).toEqual([]);
    expect(present.finalPrompt).toContain("SKU: OPTIONAL-SKU-1");
  });

  it("removes #IF blocks entirely when the controlling variable is blank", () => {
    const config: PromptConfig = {
      promptType: "product_data",
      promptName: "product_data",
      activeVersionContent: `Intro
{{#IF ADDITIONAL_INSTRUCTIONS_DATA}}
ADDITIONAL INSTRUCTIONS (MUST FOLLOW)
{{ADDITIONAL_INSTRUCTIONS_DATA}}
{{/IF}}
Outro`,
      variables: [
        { name: "ADDITIONAL_INSTRUCTIONS_DATA", bindingType: "additional_instructions_data", required: true },
      ],
    };

    const result = resolvePromptVariables(config, {});
    expect(result.validationErrors).toEqual([]);
    expect(result.finalPrompt).toContain("Intro");
    expect(result.finalPrompt).toContain("Outro");
    expect(result.finalPrompt).not.toContain("ADDITIONAL INSTRUCTIONS (MUST FOLLOW)");
    expect(result.finalPrompt).not.toContain("{{#IF");
  });

  it("keeps #IF blocks when the controlling variable has a value", () => {
    const config: PromptConfig = {
      promptType: "product_data",
      promptName: "product_data",
      activeVersionContent: `Intro
{{#IF ADDITIONAL_INSTRUCTIONS_DATA}}
ADDITIONAL INSTRUCTIONS (MUST FOLLOW)
{{ADDITIONAL_INSTRUCTIONS_DATA}}
{{/IF}}
Outro`,
      variables: [
        { name: "ADDITIONAL_INSTRUCTIONS_DATA", bindingType: "additional_instructions_data", required: true },
      ],
    };

    const result = resolvePromptVariables(config, {
      additionalInstructionsData: "Use only supplier-provided dimensions.",
    });

    expect(result.validationErrors).toEqual([]);
    expect(result.finalPrompt).toContain("ADDITIONAL INSTRUCTIONS (MUST FOLLOW)");
    expect(result.finalPrompt).toContain("Use only supplier-provided dimensions.");
    expect(result.finalPrompt).not.toContain("{{#IF");
  });

  it("supports {{IF ...}} syntax for optional compare SKU blocks", () => {
    const config: PromptConfig = {
      promptType: "compare_sheets",
      promptName: "compare_sheets",
      activeVersionContent: `Compare context
{{IF COMPARE_SKU}}
SKU: {{COMPARE_SKU}}
{{/IF}}
Next line`,
      variables: [
        { name: "COMPARE_SKU", bindingType: "compare_optional_sku", required: true },
      ],
    };

    const missing = resolvePromptVariables(config, {});
    expect(missing.validationErrors).toEqual([]);
    expect(missing.finalPrompt).toContain("Compare context");
    expect(missing.finalPrompt).toContain("Next line");
    expect(missing.finalPrompt).not.toContain("SKU:");
    expect(missing.finalPrompt).not.toContain("{{IF");

    const present = resolvePromptVariables(config, { compareOptionalSku: "ABC-123" });
    expect(present.validationErrors).toEqual([]);
    expect(present.finalPrompt).toContain("SKU: ABC-123");
  });

  it("attaches file-backed variables used only in IF blocks when the block is kept", () => {
    const config: PromptConfig = {
      promptType: "product_data",
      promptName: "product_data",
      activeVersionContent: `{{#IF DATASHEET_PDF}}
Use the supplier datasheet as a source.
{{/IF}}`,
      variables: [
        { name: "DATASHEET_PDF", bindingType: "supplier_datasheet_pdf", required: true },
      ],
    };

    const missing = resolvePromptVariables(config, {});
    expect(missing.validationErrors).toEqual([]);
    expect(missing.files).toEqual([]);
    expect(missing.finalPrompt).toBe("");

    const present = resolvePromptVariables(config, {
      datasheetUpload: {
        bucket: "test-bucket",
        path: "docs/datasheet.pdf",
        filename: "datasheet.pdf",
        label: "datasheet",
      },
    });

    expect(present.validationErrors).toEqual([]);
    expect(present.finalPrompt).toBe("Use the supplier datasheet as a source.");
    expect(present.files).toEqual([
      {
        bucket: "test-bucket",
        path: "docs/datasheet.pdf",
        filename: "datasheet.pdf",
        label: "datasheet",
      },
    ]);
  });
});
