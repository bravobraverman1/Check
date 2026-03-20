import { describe, expect, it } from "vitest";
import {
  buildCompareDatasheetsPrompt,
  buildGenerateProductDataPrompt,
  buildTitleDescriptionPrompt,
  buildDescriptionPrompt,
  getBuiltInFallbackPrompt,
} from "@/lib/aiPromptBuilders";

const USER_PROMPT_AUTHORITY_SNIPPET =
  "The user prompt is the authoritative source for the task, required output format, and what to look for.";

describe("buildCompareDatasheetsPrompt", () => {
  it("prepends user-prompt authority when missing", () => {
    const prompt = buildCompareDatasheetsPrompt({
      activePrompt: "Return a compare table for the two datasheets.",
    });

    expect(prompt).toContain(USER_PROMPT_AUTHORITY_SNIPPET);
    expect(prompt).toContain("Return a compare table for the two datasheets.");
  });

  it("does not duplicate user-prompt authority when already present", () => {
    const prompt = buildCompareDatasheetsPrompt({
      activePrompt: `${USER_PROMPT_AUTHORITY_SNIPPET}\nReturn only JSON.`,
    });

    expect(prompt.match(/authoritative source for the task/gi)).toHaveLength(1);
  });
});

describe("buildTitleDescriptionPrompt", () => {
  it("removes empty naming helper sections when no values were resolved", () => {
    const resolvedPrompt = `You are creating two things for an ecommerce product:
1. The Product Title
2. The Product Description
3. The product has the proposed title structure:

4. An example of the product title is as follows:

PRODUCT TITLE CRITICAL RULES (MUST FOLLOW)
1. Rule`;

    const prompt = buildTitleDescriptionPrompt({ resolvedPrompt });
    expect(prompt).toContain(USER_PROMPT_AUTHORITY_SNIPPET);
    expect(prompt).not.toContain("3. The product has the proposed title structure:");
    expect(prompt).not.toContain("4. An example of the product title is as follows:");
    expect(prompt).toContain("PRODUCT TITLE CRITICAL RULES");
  });

  it("keeps naming helper sections when values are present", () => {
    const resolvedPrompt = `3. The product has the proposed title structure:
Downlight + colour + wattage
4. An example of the product title is as follows:
LED Downlight White 12W Tri-CCT 900lm`;

    const prompt = buildTitleDescriptionPrompt({ resolvedPrompt });
    expect(prompt).toContain(USER_PROMPT_AUTHORITY_SNIPPET);
    expect(prompt).toContain("3. The product has the proposed title structure:");
    expect(prompt).toContain("Downlight + colour + wattage");
    expect(prompt).toContain("4. An example of the product title is as follows:");
    expect(prompt).toContain("LED Downlight White 12W Tri-CCT 900lm");
  });

  it("removes only the empty structure section when example still has content", () => {
    const resolvedPrompt = `3. The product has the proposed title structure:

4. An example of the product title is as follows:
LED Downlight White 12W Tri-CCT 900lm

PRODUCT TITLE CRITICAL RULES (MUST FOLLOW)`;

    const prompt = buildTitleDescriptionPrompt({ resolvedPrompt });
    expect(prompt).toContain(USER_PROMPT_AUTHORITY_SNIPPET);
    expect(prompt).not.toContain("3. The product has the proposed title structure:");
    expect(prompt).toContain("4. An example of the product title is as follows:");
  });
});

describe("buildDescriptionPrompt", () => {
  it("removes empty naming helper sections when no values were resolved", () => {
    const resolvedPrompt = `You are creating a description for an ecommerce product.
3. The product has the proposed title structure:

4. An example of the product title is as follows:

PRODUCT DESCRIPTION CRITICAL RULES (MUST FOLLOW)
1. Rule`;

    const prompt = buildDescriptionPrompt({ resolvedPrompt });
    expect(prompt).toContain(USER_PROMPT_AUTHORITY_SNIPPET);
    expect(prompt).not.toContain("3. The product has the proposed title structure:");
    expect(prompt).not.toContain("4. An example of the product title is as follows:");
    expect(prompt).toContain("PRODUCT DESCRIPTION CRITICAL RULES");
  });

  it("preserves numbered content rules in description prompts", () => {
    const resolvedPrompt = `PRODUCT DESCRIPTION CRITICAL RULES (MUST FOLLOW):

1. Create a detailed and professional description for the product using the product data extracted from the Datasheet.

2. The description should be four paragraphs of text (no headings and no dot points).

3. The style should be formal and technically accurate.

4. Ensure that the description is unique.

5. Start the description with "This AAA..." where AAA is the category.

6. If the product is commercial grade then start with "This commercial grade AAA...".

7. Focus on presenting the product as a high-quality, reliable solution.

8. The description must not have empty lines in between four paragraphs.

You must output ONLY valid JSON.`;

    const prompt = buildDescriptionPrompt({ resolvedPrompt });
    expect(prompt).toContain("1. Create a detailed and professional description");
    expect(prompt).toContain("2. The description should be four paragraphs");
    expect(prompt).toContain("8. The description must not have empty lines");
    expect(prompt).toContain("You must output ONLY valid JSON.");
  });
});

describe("buildGenerateProductDataPrompt", () => {
  it("does not inject hardcoded runtime context blocks", () => {
    const adminPrompt = `Extract fields from {{DATASHEET_PDF}}.
===PRODUCT_DATA===
{{FIELD_LIST}}
===CONFLICTS===`;

    const built = buildGenerateProductDataPrompt({
      resolvedAdminPrompt: adminPrompt,
      includeAdditionalInstructions: true,
      additionalInstructions: "Only use source facts.",
      includeFiltersProposalSection: true,
    });

    expect(built.prompt).toContain("Extract fields from");
    expect(built.prompt).toContain(USER_PROMPT_AUTHORITY_SNIPPET);
    expect(built.prompt).not.toContain("RUN CONTEXT:");
    expect(built.prompt).not.toContain("Main Category Path:");
    expect(built.prompt).not.toContain("Other Categories:");
    expect(built.prompt).not.toContain("AUTO-INJECTED");
    expect(built.prompt).not.toContain("FILTERS_PROPOSAL");
  });

  it("derives required sections only from explicit section headers in the prompt", () => {
    const built = buildGenerateProductDataPrompt({
      resolvedAdminPrompt: `===PRODUCT_DATA===
fields
===CONFLICTS===
notes
===FILTERS_PROPOSAL===
rows`,
    });

    expect(built.requiredSections).toEqual(["PRODUCT_DATA", "CONFLICTS", "FILTERS_PROPOSAL"]);
    expect(built.prompt).toContain(USER_PROMPT_AUTHORITY_SNIPPET);
  });

  it("keeps requiredSections empty when prompt defines no explicit sections", () => {
    const built = buildGenerateProductDataPrompt({
      resolvedAdminPrompt: "Extract all product attributes from the provided files.",
    });

    expect(built.requiredSections).toEqual([]);
    expect(built.prompt).toContain(USER_PROMPT_AUTHORITY_SNIPPET);
  });

  it("does not append FILTERS_PROPOSAL guidance automatically", () => {
    const built = buildGenerateProductDataPrompt({
      resolvedAdminPrompt: "Extract all product attributes from the provided files.",
      includeFiltersProposalSection: true,
    });

    expect(built.prompt).toContain(USER_PROMPT_AUTHORITY_SNIPPET);
    expect(built.prompt).toContain("Extract all product attributes from the provided files.");
    expect(built.requiredSections).toEqual([]);
  });

  it("strips title-output directives from generate-data prompts but keeps omit-title rules", () => {
    const built = buildGenerateProductDataPrompt({
      resolvedAdminPrompt: `Generate a product title for the item.
Omit these fields entirely if encountered: SKU, TYPE, TITLE, NAME, PRODUCT NAME.
=== PRODUCT_TITLE ===
Fancy Light Title
=== PRODUCT_DATA ===
COLOUR: White`,
    });

    expect(built.prompt).not.toContain("Generate a product title");
    expect(built.prompt).toContain(USER_PROMPT_AUTHORITY_SNIPPET);
    expect(built.prompt).not.toContain("=== PRODUCT_TITLE ===");
    expect(built.prompt).toContain("Omit these fields entirely if encountered: SKU, TYPE, TITLE, NAME, PRODUCT NAME.");
    expect(built.prompt).toContain("=== PRODUCT_DATA ===");
    expect(built.requiredSections).toEqual(["PRODUCT_DATA"]);
    expect(built.sanitization.removedTitleDirectiveLines).toBeGreaterThan(0);
    expect(built.sanitization.removedProductTitleSection).toBe(true);
  });

  it("does not treat omit-title rules as a title-output conflict by themselves", () => {
    const built = buildGenerateProductDataPrompt({
      resolvedAdminPrompt: `If a field is not provided, omit that field.
Omit these fields entirely if encountered: SKU, TYPE, TITLE, NAME, PRODUCT NAME.
Extract fields as FIELD: value lines only.`,
    });

    expect(built.prompt).toContain("Omit these fields entirely if encountered: SKU, TYPE, TITLE, NAME, PRODUCT NAME.");
    expect(built.prompt).toContain(USER_PROMPT_AUTHORITY_SNIPPET);
    expect(built.sanitization.removedTitleDirectiveLines).toBe(0);
    expect(built.sanitization.removedProductTitleSection).toBe(false);
  });
});

describe("getBuiltInFallbackPrompt", () => {
  it("keeps built-in fallback prompts minimal and does not inject old hardcoded rule blocks", () => {
    const productDataFallback = getBuiltInFallbackPrompt("product_data");
    const titleFallback = getBuiltInFallbackPrompt("technical");

    expect(productDataFallback).toContain("The user prompt is the authoritative source");
    expect(productDataFallback).not.toContain("Use attached files as the only factual source.");
    expect(productDataFallback).not.toContain("Do not add commentary.");
    expect(titleFallback).toContain("The user prompt is the authoritative source");
  });
});
