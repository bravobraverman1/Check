import { areEquivalentCompareValues, isComparePlaceholderValue } from "@/lib/pdfCompareNormalization";

export interface CompareAuditRowLike {
  field: string;
  supplier: string;
  ls: string;
}

export interface CompareAuditSummary {
  fields_a: number;
  fields_b: number;
  identical: number;
  equivalent: number;
  different: number;
  added: number;
  ignored: number;
}

export function buildComparisonAuditSummary(rows: CompareAuditRowLike[]): CompareAuditSummary {
  let fieldsA = 0;
  let fieldsB = 0;
  let identical = 0;
  let equivalent = 0;
  let different = 0;
  let added = 0;
  let ignored = 0;

  for (const row of rows) {
    const supplierPresent = !isComparePlaceholderValue(row.supplier || "");
    const lsPresent = !isComparePlaceholderValue(row.ls || "");

    if (supplierPresent) fieldsA += 1;
    if (lsPresent) fieldsB += 1;

    if (!supplierPresent && !lsPresent) {
      ignored += 1;
      continue;
    }

    if (!supplierPresent || !lsPresent) {
      added += 1;
      continue;
    }

    const supplierValue = row.supplier.trim();
    const lsValue = row.ls.trim();
    if (supplierValue === lsValue) {
      identical += 1;
      continue;
    }

    if (areEquivalentCompareValues(supplierValue, lsValue)) {
      equivalent += 1;
      continue;
    }

    different += 1;
  }

  return {
    fields_a: fieldsA,
    fields_b: fieldsB,
    identical,
    equivalent,
    different,
    added,
    ignored,
  };
}
