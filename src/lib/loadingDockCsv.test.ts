import { describe, expect, it } from "vitest";

import { buildLoadingDockCsvText, formatProductDescriptionHtml } from "./loadingDockCsv";

describe("loadingDockCsv description formatting", () => {
  it("preserves multiple description paragraphs as separate HTML paragraphs", () => {
    expect(formatProductDescriptionHtml("parag1\n\nparag2", "")).toBe("<p>parag1</p><p>parag2</p>");
  });

  it("keeps single line breaks inside a paragraph as <br/>", () => {
    expect(formatProductDescriptionHtml("line1\nline2", "")).toBe("<p>line1<br/>line2</p>");
  });
});

describe("loadingDockCsv image slot export", () => {
  it("keeps empty image columns through slot 8 when fewer than 8 images exist", () => {
    const headers = new Array<string>(60).fill("");
    const row = new Array<string>(60).fill("");

    headers[0] = "Product Name";
    row[0] = "Example";

    for (let i = 1; i <= 8; i++) {
      const base = 1 + (i - 1) * 5;
      headers[base] = `Product Image ID - ${i}`;
      headers[base + 1] = `Product Image File - ${i}`;
      headers[base + 2] = `Product Image Description - ${i}`;
      headers[base + 3] = `Product Image Is Thumbnail - ${i}`;
      headers[base + 4] = `Product Image Sort - ${i}`;
      row[base + 3] = i === 1 ? "Y" : "N";
      row[base + 4] = String(i - 1);
      if (i <= 3) row[base + 1] = `https://example.com/image-${i}.jpg`;
    }

    const csvText = buildLoadingDockCsvText(headers, row);
    expect(csvText).toContain("Product Image Sort - 8");
    expect(csvText).not.toContain("Product Image ID - 9");
  });

  it("exports image columns through the highest populated slot when more than 8 images exist", () => {
    const headers = new Array<string>(90).fill("");
    const row = new Array<string>(90).fill("");

    headers[0] = "Product Name";
    row[0] = "Example";

    for (let i = 1; i <= 12; i++) {
      const base = 1 + (i - 1) * 5;
      headers[base] = `Product Image ID - ${i}`;
      headers[base + 1] = `Product Image File - ${i}`;
      headers[base + 2] = `Product Image Description - ${i}`;
      headers[base + 3] = `Product Image Is Thumbnail - ${i}`;
      headers[base + 4] = `Product Image Sort - ${i}`;
      if (i <= 10) row[base + 1] = `https://example.com/image-${i}.jpg`;
      if (i <= 10) row[base + 3] = i === 1 ? "Y" : "N";
      if (i <= 10) row[base + 4] = String(i - 1);
    }

    const csvText = buildLoadingDockCsvText(headers, row);
    expect(csvText).toContain("Product Image Sort - 10");
    expect(csvText).not.toContain("Product Image ID - 11");
  });

  it("preserves real columns after the trimmed image slots", () => {
    const headers = new Array<string>(110).fill("");
    const row = new Array<string>(110).fill("");

    headers[0] = "Product Name";
    row[0] = "Example";

    for (let i = 1; i <= 12; i++) {
      const base = 1 + (i - 1) * 5;
      headers[base] = `Product Image ID - ${i}`;
      headers[base + 1] = `Product Image File - ${i}`;
      headers[base + 2] = `Product Image Description - ${i}`;
      headers[base + 3] = `Product Image Is Thumbnail - ${i}`;
      headers[base + 4] = `Product Image Sort - ${i}`;
      if (i <= 10) row[base + 1] = `https://example.com/image-${i}.jpg`;
      if (i <= 10) row[base + 3] = i === 1 ? "Y" : "N";
      if (i <= 10) row[base + 4] = String(i - 1);
    }

    headers[80] = "Page Title";
    row[80] = "Example Page Title";
    headers[81] = "Meta Description";
    row[81] = "Example meta description";
    headers[82] = "GPS Category";
    row[82] = "Lighting ; Indoor";
    headers[83] = "Product Custom Fields";
    row[83] = "Fan Cutout=150X165; Air Movement=1234; Type=Recessed";

    const csvText = buildLoadingDockCsvText(headers, row);
    expect(csvText).toContain("Product Image Sort - 10");
    expect(csvText).not.toContain("Product Image ID - 11");
    expect(csvText).toContain("Page Title");
    expect(csvText).toContain("Example Page Title");
    expect(csvText).toContain("Meta Description");
    expect(csvText).toContain("Example meta description");
    expect(csvText).toContain("GPS Category");
    expect(csvText).toContain("Lighting;Indoor");
    expect(csvText).toContain("Product Custom Fields");
    expect(csvText).toContain("Fan Cutout=150cm x 165cm;Air Movement=1234m³/h;Type=Recessed");
  });

  it("keeps the full known post-image schema through Product Custom Fields even when blank", () => {
    const headers = new Array<string>(130).fill("");
    const row = new Array<string>(130).fill("");

    headers[0] = "Product Name";
    row[0] = "Example";

    for (let i = 1; i <= 12; i++) {
      const base = 1 + (i - 1) * 5;
      headers[base] = `Product Image ID - ${i}`;
      headers[base + 1] = `Product Image File - ${i}`;
      headers[base + 2] = `Product Image Description - ${i}`;
      headers[base + 3] = `Product Image Is Thumbnail - ${i}`;
      headers[base + 4] = `Product Image Sort - ${i}`;
      if (i <= 3) row[base + 1] = `https://example.com/image-${i}.jpg`;
      if (i <= 3) row[base + 3] = i === 1 ? "Y" : "N";
      if (i <= 3) row[base + 4] = String(i - 1);
    }

    const trailingHeaders = [
      "Search Keywords",
      "Page Title",
      "Meta Keywords",
      "Meta Description",
      "MYOB Asset Acct",
      "MYOB Income Acct",
      "MYOB Expense Acct",
      "Product Condition",
      "Show Product Condition?",
      "Event Date Required?",
      "Event Date Name",
      "Event Date Is Limited?",
      "Event Date Start Date",
      "Event Date End Date",
      "Sort Order",
      "Product Tax Class",
      "Product UPC/EAN",
      "Stop Processing Rules",
      "Product URL",
      "Redirect Old URL?",
      "GPS Manufacturer Part Number",
      "GPS Category",
      "GPS Enabled",
      "Avalara Product Tax Code",
      "Product Custom Fields",
    ];
    trailingHeaders.forEach((header, index) => {
      headers[80 + index] = header;
    });

    const csvText = buildLoadingDockCsvText(headers, row);
    expect(csvText).toContain("Product Image Sort - 8");
    expect(csvText).not.toContain("Product Image ID - 9");
    expect(csvText).toContain("Search Keywords");
    expect(csvText).toContain("Product Custom Fields");
  });

  it("ignores invisible or placeholder file-cell residue beyond the real image URLs", () => {
    const headers = new Array<string>(120).fill("");
    const row = new Array<string>(120).fill("");

    headers[0] = "Product Name";
    row[0] = "Example";

    for (let i = 1; i <= 12; i++) {
      const base = 1 + (i - 1) * 5;
      headers[base] = `Product Image ID - ${i}`;
      headers[base + 1] = `Product Image File - ${i}`;
      headers[base + 2] = `Product Image Description - ${i}`;
      headers[base + 3] = `Product Image Is Thumbnail - ${i}`;
      headers[base + 4] = `Product Image Sort - ${i}`;
      row[base + 3] = i === 1 ? "Y" : "N";
      row[base + 4] = String(i - 1);
      if (i <= 2) row[base + 1] = `https://example.com/image-${i}.jpg`;
    }

    // Slot 9 file = zero-width space, slot 10 = BOM, slot 11 = "N/A", slot 12 = "0"
    row[42] = "\u200B";
    row[47] = "\uFEFF";
    row[52] = "N/A";
    row[57] = "0";

    const csvText = buildLoadingDockCsvText(headers, row);
    expect(csvText).toContain("Product Image Sort - 8");
    expect(csvText).not.toContain("Product Image ID - 9");
    expect(csvText).not.toContain("Product Image Sort - 9");
  });
});
