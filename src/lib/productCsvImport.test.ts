import { describe, expect, it } from "vitest";
import { parseProductCsvImport } from "@/lib/productCsvImport";
import type { PropertyDefinition } from "@/data/defaultProperties";

describe("parseProductCsvImport", () => {
  it("splits product description, maps numbered custom fields, and preserves image slots", () => {
    const properties: PropertyDefinition[] = [
      { name: "Colour #1", key: "colour1", inputType: "dropdown", section: "Colours" },
      { name: "Colour #2", key: "colour2", inputType: "dropdown", section: "Colours" },
      { name: "IP Rating", key: "ipRating", inputType: "dropdown", section: "Technical" },
    ];

    const csvText = [
      [
        "Product Code/SKU",
        "Brand Name",
        "Product Name",
        "Category",
        "Product Description",
        "Product Custom Fields",
        "Product Image File - 1",
        "Product Image File - 3",
        "Email Notes",
      ].join(","),
      [
        "ABC-123",
        "Acme",
        "Ceiling Light",
        '"Indoor;Ceiling Lights"',
        '"<p>Main description paragraph.</p><p><strong>Voltage:</strong> 240V <br/><strong>Wattage:</strong> 10W <br/></p>"',
        '"Colour=White;Colour=Black;IP Rating=IP65"',
        "https://example.com/a.jpg",
        "https://example.com/c.jpg",
        "Use warm tone",
      ].join(","),
    ].join("\n");

    const result = parseProductCsvImport(csvText, {
      filename: "product.csv",
      properties,
    });

    expect(result.formData.sku).toBe("ABC-123");
    expect(result.formData.brand).toBe("Acme");
    expect(result.formData.title).toBe("Ceiling Light");
    expect(result.formData.mainCategory).toBe("Indoor");
    expect(result.formData.selectedCategories).toEqual(["Indoor", "Ceiling Lights"]);
    expect(result.formData.chatgptDescription).toBe("Main description paragraph.");
    expect(result.formData.chatgptData).toBe("Voltage: 240V\nWattage: 10W");
    expect(result.formData.emailNotes).toBe("Use warm tone");
    expect(result.formData.imageUrls).toEqual([
      "https://example.com/a.jpg",
      "https://example.com/c.jpg",
    ]);
    expect(result.formData.specValues).toEqual({
      colour1: "White",
      colour2: "Black",
      ipRating: "IP65",
    });
    expect(result.jsonPayload.images).toEqual([
      { slot: 1, value: "https://example.com/a.jpg" },
      { slot: 3, value: "https://example.com/c.jpg" },
    ]);
    expect(result.jsonPayload.customFields.map((entry) => entry.displayName)).toEqual([
      "Colour #1",
      "Colour #2",
      "IP Rating #1",
    ]);
  });

  it("parses MPN into the form and JSON payload so viewer product code does not fall back to SKU", () => {
    const csvText = [
      [
        "Product Code/SKU",
        "Manufacturer Part Number",
        "Brand Name",
        "Product Name",
      ].join(","),
      [
        "10083--DOM",
        "10083--DOM-L",
        "Domus",
        "Downlight",
      ].join(","),
    ].join("\n");

    const result = parseProductCsvImport(csvText, {
      filename: "product.csv",
      properties: [],
    });

    expect(result.formData.sku).toBe("10083--DOM");
    expect(result.formData.gpsMpn).toBe("10083--DOM-L");
    expect(result.jsonPayload.basicFields.gpsMpn).toBe("10083--DOM-L");
    expect(result.jsonPayload.formData.gpsMpn).toBe("10083--DOM-L");
  });
});
