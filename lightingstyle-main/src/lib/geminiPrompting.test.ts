import { describe, expect, it } from "vitest";
import { renderPromptConditionals, renderPromptTemplate } from "@/lib/geminiPrompting";

describe("renderPromptConditionals", () => {
  it("supports both {{#IF ...}} and {{IF ...}} syntaxes", () => {
    const template = `A
{{#IF FIRST}}First: {{FIRST}}{{/IF}}
{{IF SECOND}}Second: {{SECOND}}{{/IF}}
Z`;

    const rendered = renderPromptConditionals(template, {
      FIRST: "one",
      SECOND: "",
    });

    expect(rendered).toContain("First: {{FIRST}}");
    expect(rendered).not.toContain("Second:");
    expect(rendered).not.toContain("{{#IF");
    expect(rendered).not.toContain("{{IF");
  });
});

describe("renderPromptTemplate", () => {
  it("replaces variables after conditional blocks are resolved", () => {
    const template = `Start
{{IF EXTRA}}
Extra: {{EXTRA}}
{{/IF}}
End`;

    const rendered = renderPromptTemplate(template, { EXTRA: "details" });
    expect(rendered).toContain("Start");
    expect(rendered).toContain("Extra: details");
    expect(rendered).toContain("End");
    expect(rendered).not.toContain("{{IF");
    expect(rendered).not.toContain("{{/IF}}");
  });
});
