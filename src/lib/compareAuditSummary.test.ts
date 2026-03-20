import { describe, expect, it } from "vitest";

import { buildComparisonAuditSummary } from "@/lib/compareAuditSummary";

describe("buildComparisonAuditSummary", () => {
  it("counts one-sided rows using placeholder markers", () => {
    expect(
      buildComparisonAuditSummary([
        { field: "MATERIAL", supplier: "MISSING***", ls: "Aluminium" },
        { field: "WARRANTY", supplier: "---", ls: "5 years" },
      ]),
    ).toEqual({
      fields_a: 0,
      fields_b: 2,
      identical: 0,
      equivalent: 0,
      different: 0,
      added: 2,
      ignored: 0,
    });
  });

  it("distinguishes identical, equivalent, and different populated rows", () => {
    expect(
      buildComparisonAuditSummary([
        { field: "COLOUR", supplier: "White", ls: "White" },
        { field: "DIMENSIONS", supplier: "172mm; 69mm", ls: "69mm; 172mm" },
        { field: "WARRANTY", supplier: "5 years", ls: "3 years" },
      ]),
    ).toEqual({
      fields_a: 3,
      fields_b: 3,
      identical: 1,
      equivalent: 1,
      different: 1,
      added: 0,
      ignored: 0,
    });
  });
});
