export function extractNumericMpnFromValue(raw: unknown): number | null {
  const value = Number((raw ?? "").toString().trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type SubmitMpnDecision =
  | { kind: "reuse-existing"; mpn: number }
  | { kind: "reserve-new" }
  | { kind: "error"; error: string };

export function decideSubmitMpn(args: {
  isOverwrite: boolean;
  existingDockMpnRaw: unknown;
  sku: string;
}): SubmitMpnDecision {
  if (!args.isOverwrite) {
    return { kind: "reserve-new" };
  }

  const existingMpn = extractNumericMpnFromValue(args.existingDockMpnRaw);
  if (existingMpn) {
    return { kind: "reuse-existing", mpn: existingMpn };
  }

  return {
    kind: "error",
    error: `Override could not read the existing MPN for SKU "${args.sku}" from Loading Dock.`,
  };
}
