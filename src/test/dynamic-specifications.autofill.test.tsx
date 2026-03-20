import React from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

import { DynamicSpecifications } from "@/components/DynamicSpecifications";
import type { FilterProposal } from "@/lib/parseGeminiSections";

describe("DynamicSpecifications autofill", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  const properties: { key: string; name: string; inputType: "text" | "dropdown"; required: boolean; section: string; unitSuffix: string }[] = [
    {
      key: "airMovement1",
      name: "Air Movement",
      inputType: "text" as const,
      required: true,
      section: "Filters",
      unitSuffix: "m³/h",
    },
  ];

  const masterLookup = [
    {
      defaultName: "Default Exhaust Fans",
      categoryPath: "Fans/Exhaust Fans/All Exhaust Fans",
    },
  ];

  const masterDefaults = [
    {
      name: "Default Exhaust Fans",
      allowedProperties: ["Air Movement"],
    },
  ];

  const proposals: FilterProposal[] = [
    {
      filterName: "Air Movement",
      value: "44m³/h",
      confidence: 90,
    },
  ];

  it("autofills an empty field from an eligible AI proposal", async () => {
    const onChange = vi.fn();
    const onFilterSourceChange = vi.fn();

    render(
      <DynamicSpecifications
        properties={properties}
        legalValues={[]}
        values={{}}
        onChange={onChange}
        selectedMainCategory="Fans/Exhaust Fans/All Exhaust Fans"
        masterLookup={masterLookup}
        masterDefaults={masterDefaults}
        filterProposals={proposals}
        filterSources={{}}
        onFilterSourceChange={onFilterSourceChange}
      />,
    );

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("airMovement1", "44");
      expect(onFilterSourceChange).toHaveBeenCalledWith("airMovement1", "ai");
    });
  });

  it("does not overwrite a sourced field with an AI proposal", async () => {
    const onChange = vi.fn();
    const onFilterSourceChange = vi.fn();

    render(
      <DynamicSpecifications
        properties={properties}
        legalValues={[]}
        values={{ airMovement1: "44" }}
        onChange={onChange}
        selectedMainCategory="Fans/Exhaust Fans/All Exhaust Fans"
        masterLookup={masterLookup}
        masterDefaults={masterDefaults}
        filterProposals={proposals}
        filterSources={{ airMovement1: "sheet" }}
        onFilterSourceChange={onFilterSourceChange}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(onChange).not.toHaveBeenCalled();
    expect(onFilterSourceChange).not.toHaveBeenCalled();
  });
});
