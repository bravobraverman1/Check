import { describe, expect, it } from "vitest";
import { parseTitleDescriptionJson } from "@/lib/parseTitleDescriptionJson";

describe("parseTitleDescriptionJson", () => {
  it("parses standard title/description keys", () => {
    const parsed = parseTitleDescriptionJson('{"title":"T1","description":"D1"}');
    expect(parsed).toEqual({ title: "T1", description: "D1" });
  });

  it("parses AI-Description style keys from custom user output", () => {
    const parsed = parseTitleDescriptionJson('{"Title":"T2","AI-Description":"D2"}');
    expect(parsed).toEqual({ title: "T2", description: "D2" });
  });

  it("parses nested wrapper payloads", () => {
    const parsed = parseTitleDescriptionJson('{"result":{"product_title":"T3","product-description":"D3"}}');
    expect(parsed).toEqual({ title: "T3", description: "D3" });
  });

  it("parses wrapped JSON strings from worker-style payloads", () => {
    const parsed = parseTitleDescriptionJson('{"result":"{\\"title\\":\\"T3b\\",\\"description\\":\\"D3b\\"}"}');
    expect(parsed).toEqual({ title: "T3b", description: "D3b" });
  });

  it("repairs truncated unterminated description strings", () => {
    const parsed = parseTitleDescriptionJson('{"title":"T4","description":"D4 starts here');
    expect(parsed).toEqual({ title: "T4", description: "D4 starts here" });
  });

  it("extracts valid json content from fenced/prefixed text", () => {
    const parsed = parseTitleDescriptionJson('Here is the output:\n```json\n{"title":"T5","description":"D5"}\n```');
    expect(parsed).toEqual({ title: "T5", description: "D5" });
  });

  it("collapses blank lines and CRLF in description", () => {
    const parsed = parseTitleDescriptionJson(
      '{"title":"T6","description":"Line 1\r\n\r\n   \r\nLine 2\n\nLine 3"}',
    );
    expect(parsed).toEqual({ title: "T6", description: "Line 1\nLine 2\nLine 3" });
  });

  it("returns null when required fields are missing", () => {
    const parsed = parseTitleDescriptionJson('{"title":"Only title"}');
    expect(parsed).toBeNull();
  });
});
