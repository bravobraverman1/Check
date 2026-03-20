/**
 * Prompt Variable Resolver — Single source of truth for runtime variable resolution.
 *
 * Used by every AI action to:
 * 1) Resolve {{VARIABLE}} placeholders and {{#IF VARIABLE}} / {{IF VARIABLE}} blocks in admin prompts using BindingType
 * 2) Build the file list for the async job pipeline
 * 3) Validate required inputs before job start
 * 4) Produce debug info for admin verification
 *
 * The resolver does NOT call the pipeline — it returns everything the caller needs.
 */

import { renderPromptConditionals } from "@/lib/geminiPrompting";

// ── Binding Type Enum ──────────────────────────────────────────

export const BINDING_TYPES = [
  // File Attachments
  { value: "instruction_pdf",               label: "Instruction PDF" },
  { value: "supplier_datasheet_pdf",        label: "Supplier Datasheet PDF (Form)" },
  { value: "supplier_website_pdf",          label: "Supplier Website PDF (Form)" },
  { value: "admin_create_description_datasheet_pdf", label: "Admin Create Description Datasheet PDF" },
  { value: "compare_supplier_pdf",          label: "Compare: Supplier Datasheet PDF" },
  { value: "compare_ls_pdf",               label: "Compare: LS Datasheet PDF" },
  // Product Identity Fields
  { value: "form_sku",                      label: "SKU (selected)" },
  { value: "compare_optional_sku",          label: "Compare SKU (optional)" },
  { value: "form_brand",                    label: "Brand" },
  { value: "form_title",                    label: "Title" },
  { value: "form_description",              label: "Description" },
  { value: "form_main_category",            label: "Main Category (path)" },
  { value: "form_selected_categories",      label: "All Selected Categories" },
  // Product Data Fields
  { value: "form_ai_data_edited",           label: "AI Data" },
  { value: "form_data_text",                label: "Form Data (all fields)" },
  { value: "form_specifications_summary",   label: "Specifications / Filters (filled)" },
  { value: "form_image_urls",               label: "Image URLs" },
  { value: "form_email_notes",              label: "Email Notes" },
  // Instructions
  { value: "additional_instructions_data",  label: "Additional Instructions (Data)" },
  { value: "additional_instructions_title", label: "Additional Instructions (Title)" },
  { value: "admin_fitting_type",            label: "Admin Fitting Type" },
  // Naming & Categories
  { value: "category_name_structure",       label: "Main Category — Name Structure" },
  { value: "category_name_example",         label: "Main Category — Name Example" },
  // Filter Context (auto-generated from category)
  { value: "form_filter_context",           label: "Filter Context (available filters + options)" },
  // Other
  { value: "custom_text",                   label: "Custom / Static text" },
] as const;

export type BindingType = typeof BINDING_TYPES[number]["value"];

// ── Input Types ────────────────────────────────────────────────

export interface PromptVariable {
  name: string;
  bindingType: BindingType;
  description?: string;
  required?: boolean; // default true
}

export interface PromptConfig {
  promptType: string;
  promptName: string;
  activeVersionContent: string;
  variables: PromptVariable[];
}

export interface FileRef {
  bucket: string;
  path: string;
  filename: string;
  label: string;
}

/** Runtime context from the current form state */
export interface RuntimeContext {
  /** Instruction PDF for this specific prompt (from Admin per-prompt upload) */
  instructionPdf?: FileRef | null;
  /** Supplier datasheet PDF uploaded in Product Entry */
  datasheetUpload?: FileRef | null;
  /** Datasheet PDF uploaded in Admin → Create Description */
  adminCreateDescriptionDatasheetUpload?: FileRef | null;
  /** Supplier website PDF uploaded in Product Entry */
  websiteUpload?: FileRef | null;
  /** Compare: Supplier Datasheet PDF (from Compare Two Datasheets) */
  compareSupplierPdf?: FileRef | null;
  /** Compare: LS Datasheet PDF (from Compare Two Datasheets) */
  compareLsPdf?: FileRef | null;
  // Product identity
  formSku?: string;
  compareOptionalSku?: string;
  formBrand?: string;
  formTitle?: string;
  formDescription?: string;
  formMainCategory?: string;
  formSelectedCategories?: string;
  // Product data
  editedAiDataText?: string;
  formDataText?: string;
  formSpecificationsSummary?: string;
  formImageUrls?: string;
  formEmailNotes?: string;
  // Instructions
  additionalInstructionsData?: string;
  additionalInstructionsTitle?: string;
  /** Admin Create Description "Fitting Type" field */
  adminFittingType?: string;
  /** Category Name Structure from sheet lookup */
  categoryNameStructure?: string;
  /** Category Name Example from sheet lookup */
  categoryNameExample?: string;
  /** Filter context string (filter names, types, allowed values) — auto-built from category */
  formFilterContext?: string;
}

// ── Output Types ───────────────────────────────────────────────

export interface ResolvedVariable {
  variableName: string;
  bindingType: BindingType;
  resolvedKind: "file" | "text" | "missing";
  label?: string;       // file label if resolvedKind=file
  textChars?: number;   // char count if resolvedKind=text
  required: boolean;
}

export interface ResolveResult {
  finalPrompt: string;
  files: FileRef[];
  debugResolved: ResolvedVariable[];
  validationErrors: string[];
}

// ── Legacy binding compatibility ──────────────────────────────

const LEGACY_BINDING_TYPE_MAP: Partial<Record<string, BindingType>> = {
  datasheet_pdf: "supplier_datasheet_pdf",
  website_pdf: "supplier_website_pdf",
  form_data: "form_data_text",
  additional_instructions: "additional_instructions_data",
  edited_ai_data: "form_ai_data_edited",
  sku: "form_sku",
  selected_sku: "form_sku",
  product_sku: "form_sku",
  compare_sku: "compare_optional_sku",
  optional_sku: "compare_optional_sku",
  compare_optional: "compare_optional_sku",
};

const VARIABLE_NAME_BINDING_MAP: Partial<Record<string, BindingType>> = {
  INSTRUCTION_PDF: "instruction_pdf",
  DATASHEET_PDF: "supplier_datasheet_pdf",
  SUPPLIER_PDF: "supplier_datasheet_pdf",
  SUPPLIER_DATASHEET_PDF: "supplier_datasheet_pdf",
  WEBSITE_PDF: "supplier_website_pdf",
  WEBPAGE_PDF: "supplier_website_pdf",
  LS_PDF: "supplier_website_pdf",
  FILTER_CONTEXT: "form_filter_context",
  FORM_DATA: "form_data_text",
  AI_DATA: "form_ai_data_edited",
  EDITED_AI_DATA: "form_ai_data_edited",
  SKU: "form_sku",
  BRAND: "form_brand",
  FITTING_TYPE: "admin_fitting_type",
  ADMIN_DATASHEET_PDF: "admin_create_description_datasheet_pdf",
};

function inferCompareSheetsBindingByName(name: string, currentBindingType: BindingType): BindingType {
  if (currentBindingType !== "custom_text") {
    if (currentBindingType === "form_sku") return "compare_optional_sku";
    return currentBindingType;
  }

  const key = name.trim().toUpperCase();
  if (key === "SKU") return "compare_optional_sku";
  if (key === "INSTRUCTION_PDF") return "instruction_pdf";
  if (key === "DATASHEET_PDF" || key === "SUPPLIER_PDF" || key === "SUPPLIER_DATASHEET_PDF") {
    return "supplier_datasheet_pdf";
  }
  if (key === "WEBPAGE_PDF" || key === "LS_PDF" || key === "WEBSITE_PDF") {
    return "supplier_website_pdf";
  }

  return "custom_text";
}

export function normalizePromptVariableBindingType(raw: string): BindingType {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "custom_text";

  const exactMatch = BINDING_TYPES.some((binding) => binding.value === trimmed);
  if (exactMatch) return trimmed as BindingType;

  const mapped = LEGACY_BINDING_TYPE_MAP[trimmed.toLowerCase()];
  if (mapped) return mapped;

  return "custom_text";
}

function getEffectiveBindingType(bindingType: BindingType, promptType: string): BindingType {
  // Backward compatibility for compare prompts that historically used `form_sku`.
  // Compare UI has optional SKU semantics, so map to compare_optional_sku.
  if (promptType.trim().toLowerCase() === "compare_sheets" && bindingType === "form_sku") {
    return "compare_optional_sku";
  }
  return bindingType;
}

function inferBindingTypeFromVariableName(
  variableName: string,
  promptType: string,
  currentBindingType?: BindingType,
): BindingType {
  const current = currentBindingType ?? "custom_text";
  if (current !== "custom_text") {
    return getEffectiveBindingType(current, promptType);
  }

  const normalizedName = variableName.trim().toUpperCase();
  if (!normalizedName) return current;

  if (promptType.trim().toLowerCase() === "compare_sheets") {
    return inferCompareSheetsBindingByName(normalizedName, current);
  }

  const inferred = VARIABLE_NAME_BINDING_MAP[normalizedName];
  return inferred ? getEffectiveBindingType(inferred, promptType) : current;
}

export function extractPromptPlaceholderNames(prompt: string): string[] {
  return Array.from(
    new Set(
      Array.from(prompt.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)).map((match) => (match[1] || "").trim()),
    ),
  );
}

export function extractPromptConditionalNames(prompt: string): string[] {
  return Array.from(
    new Set(
      Array.from(prompt.matchAll(/\{\{#?IF\s+([A-Z0-9_]+)\s*\}\}/gi)).map((match) => ((match[1] || "").trim().toUpperCase())),
    ),
  );
}

export function getPromptVariablesInUse(config: Pick<PromptConfig, "promptType" | "activeVersionContent" | "variables">): PromptVariable[] {
  const normalizedPromptType = config.promptType.trim().toLowerCase();
  const placeholderMatches = extractPromptPlaceholderNames(config.activeVersionContent);
  const plainPlaceholderNames = new Set(placeholderMatches);
  const conditionalMatches = extractPromptConditionalNames(config.activeVersionContent);
  const allReferencedNames = Array.from(new Set([...placeholderMatches, ...conditionalMatches]));
  const declaredVariables = new Map(
    config.variables.map((variable) => [variable.name.trim().toUpperCase(), variable] as const),
  );

  return allReferencedNames.flatMap((placeholderName) => {
    if (!placeholderName || placeholderName === "ADDITIONAL_INSTRUCTIONS") return [];

    const declared = declaredVariables.get(placeholderName);
    const isPlainPlaceholder = plainPlaceholderNames.has(placeholderName);
    if (declared) {
      const normalizedBindingType = normalizePromptVariableBindingType(String(declared.bindingType || ""));
      return [{
        ...declared,
        name: placeholderName,
        bindingType: inferBindingTypeFromVariableName(placeholderName, normalizedPromptType, normalizedBindingType),
        required: isPlainPlaceholder ? declared.required !== false : false,
      }];
    }

    const inferredBindingType = inferBindingTypeFromVariableName(placeholderName, normalizedPromptType);
    if (inferredBindingType === "custom_text") return [];

    return [{
      name: placeholderName,
      bindingType: inferredBindingType,
      required: isPlainPlaceholder,
    }];
  });
}

// ── File label mapping (stable, not derived from prompt name) ──

const BINDING_TO_FILE_LABEL: Partial<Record<BindingType, string>> = {
  instruction_pdf: "instructions",
  supplier_datasheet_pdf: "datasheet",
  admin_create_description_datasheet_pdf: "datasheet",
  supplier_website_pdf: "website_pdf",
  compare_supplier_pdf: "compare_supplier",
  compare_ls_pdf: "compare_ls",
};

// ── Core Resolver ──────────────────────────────────────────────

export function resolvePromptVariables(
  config: PromptConfig,
  ctx: RuntimeContext,
): ResolveResult {
  const files: FileRef[] = [];
  const debugResolved: ResolvedVariable[] = [];
  const validationErrors: string[] = [];
  let prompt = config.activeVersionContent;

  // Deduplicate file labels to avoid attaching same file twice
  const attachedLabels = new Set<string>();
  const allVariables = getPromptVariablesInUse(config);
  const resolvedByVariableName = new Map<string, {
    variable: PromptVariable;
    bindingType: BindingType;
    isRequired: boolean;
    resolved: BindingResult;
  }>();

  for (const variable of allVariables) {
    const bindingType = variable.bindingType;
    const isRequired = variable.required !== false;
    resolvedByVariableName.set(variable.name.trim().toUpperCase(), {
      variable,
      bindingType,
      isRequired,
      resolved: resolveBinding(bindingType, ctx),
    });
  }

  const conditionalNames = extractPromptConditionalNames(prompt);
  if (conditionalNames.length > 0) {
    const conditionalValues: Record<string, string> = {};
    for (const conditionalName of conditionalNames) {
      const resolvedEntry = resolvedByVariableName.get(conditionalName);
      const resolved = resolvedEntry?.resolved;
      const includeBlock = resolved?.kind === "file"
        ? Boolean(resolved.fileRef)
        : resolved?.kind === "text"
        ? Boolean(resolved.text)
        : false;

      conditionalValues[conditionalName] = includeBlock ? "1" : "";

      if (includeBlock && resolvedEntry && resolved.kind === "file" && resolved.fileRef) {
        const label = BINDING_TO_FILE_LABEL[resolvedEntry.bindingType] || resolvedEntry.variable.name.toLowerCase();
        if (!attachedLabels.has(label)) {
          files.push({ ...resolved.fileRef, label });
          attachedLabels.add(label);
        }
      }
    }

    prompt = renderPromptConditionals(prompt, conditionalValues);
  }

  const activePlaceholderNames = new Set(extractPromptPlaceholderNames(prompt));

  for (const variable of allVariables) {
    const normalizedVariableName = variable.name.trim().toUpperCase();
    if (!activePlaceholderNames.has(normalizedVariableName)) continue;

    const bindingType = variable.bindingType;
    const isRequired = variable.required !== false; // default true
    const placeholder = `{{${variable.name}}}`;
    const resolved = resolvedByVariableName.get(normalizedVariableName)?.resolved ?? resolveBinding(bindingType, ctx);

    if (resolved.kind === "file" && resolved.fileRef) {
      const label = BINDING_TO_FILE_LABEL[bindingType] || variable.name.toLowerCase();

      // Replace placeholder with label injection
      prompt = prompt.split(placeholder).join(`ATTACHED_FILE_LABEL: ${label}`);

      // Attach file (avoid duplicates)
      if (!attachedLabels.has(label)) {
        files.push({ ...resolved.fileRef, label });
        attachedLabels.add(label);
      }

      debugResolved.push({
        variableName: variable.name,
        bindingType,
        resolvedKind: "file",
        label,
        required: isRequired,
      });

    } else if (resolved.kind === "text" && resolved.text) {
      prompt = prompt.split(placeholder).join(resolved.text);

      debugResolved.push({
        variableName: variable.name,
        bindingType,
        resolvedKind: "text",
        textChars: resolved.text.length,
        required: isRequired,
      });

    } else if (resolved.kind === "text" && !resolved.text) {
      // Empty text (e.g. no filters for category) — prune lines but no validation error
      prompt = pruneLines(prompt, placeholder);

      debugResolved.push({
        variableName: variable.name,
        bindingType,
        resolvedKind: "text",
        textChars: 0,
        required: isRequired,
      });

    } else {
      // Missing
      if (isRequired) {
        validationErrors.push(getMissingErrorMessage(variable, bindingType));
      }

      // LINE PRUNING: remove entire lines containing unresolved placeholder
      prompt = pruneLines(prompt, placeholder);

      debugResolved.push({
        variableName: variable.name,
        bindingType,
        resolvedKind: "missing",
        required: isRequired,
      });
    }
  }

  // Remove blank lines left by pruning
  prompt = prompt.replace(/\n{3,}/g, "\n\n").trim();

  return { finalPrompt: prompt, files, debugResolved, validationErrors };
}

// ── Binding resolution ─────────────────────────────────────────

interface BindingResult {
  kind: "file" | "text" | "missing";
  fileRef?: FileRef;
  text?: string;
}

function resolveBinding(bindingType: BindingType, ctx: RuntimeContext): BindingResult {
  switch (bindingType) {
    case "instruction_pdf":
      return ctx.instructionPdf
        ? { kind: "file", fileRef: ctx.instructionPdf }
        : { kind: "missing" };

    case "supplier_datasheet_pdf":
      return ctx.datasheetUpload
        ? { kind: "file", fileRef: ctx.datasheetUpload }
        : { kind: "missing" };

    case "admin_create_description_datasheet_pdf":
      return ctx.adminCreateDescriptionDatasheetUpload
        ? { kind: "file", fileRef: ctx.adminCreateDescriptionDatasheetUpload }
        : { kind: "missing" };

    case "supplier_website_pdf":
      return ctx.websiteUpload
        ? { kind: "file", fileRef: ctx.websiteUpload }
        : { kind: "missing" };

    case "compare_supplier_pdf":
      return ctx.compareSupplierPdf
        ? { kind: "file", fileRef: ctx.compareSupplierPdf }
        : { kind: "missing" };

    case "compare_ls_pdf":
      return ctx.compareLsPdf
        ? { kind: "file", fileRef: ctx.compareLsPdf }
        : { kind: "missing" };

    // Product identity
    case "form_sku":
      return ctx.formSku?.trim()
        ? { kind: "text", text: ctx.formSku.trim() }
        : { kind: "missing" };

    case "compare_optional_sku":
      return ctx.compareOptionalSku?.trim()
        ? { kind: "text", text: ctx.compareOptionalSku.trim() }
        : { kind: "text", text: "" };

    case "form_brand":
      return ctx.formBrand?.trim()
        ? { kind: "text", text: ctx.formBrand.trim() }
        : { kind: "missing" };

    case "form_title":
      return ctx.formTitle?.trim()
        ? { kind: "text", text: ctx.formTitle.trim() }
        : { kind: "missing" };

    case "form_description":
      return ctx.formDescription?.trim()
        ? { kind: "text", text: ctx.formDescription.trim() }
        : { kind: "missing" };

    case "form_main_category":
      return ctx.formMainCategory?.trim()
        ? { kind: "text", text: ctx.formMainCategory.trim() }
        : { kind: "missing" };

    case "form_selected_categories":
      return ctx.formSelectedCategories?.trim()
        ? { kind: "text", text: ctx.formSelectedCategories.trim() }
        : { kind: "missing" };

    // Product data
    case "form_ai_data_edited":
      return ctx.editedAiDataText?.trim()
        ? { kind: "text", text: ctx.editedAiDataText.trim() }
        : { kind: "missing" };

    case "form_data_text":
      return ctx.formDataText?.trim()
        ? { kind: "text", text: ctx.formDataText.trim() }
        : { kind: "missing" };

    case "form_specifications_summary":
      return ctx.formSpecificationsSummary?.trim()
        ? { kind: "text", text: ctx.formSpecificationsSummary.trim() }
        : { kind: "missing" };

    case "form_image_urls":
      return ctx.formImageUrls?.trim()
        ? { kind: "text", text: ctx.formImageUrls.trim() }
        : { kind: "missing" };

    case "form_email_notes":
      return ctx.formEmailNotes?.trim()
        ? { kind: "text", text: ctx.formEmailNotes.trim() }
        : { kind: "missing" };

    // Instructions
    case "additional_instructions_data":
      return ctx.additionalInstructionsData?.trim()
        ? { kind: "text", text: ctx.additionalInstructionsData.trim() }
        : { kind: "missing" };

    case "additional_instructions_title":
      return ctx.additionalInstructionsTitle?.trim()
        ? { kind: "text", text: ctx.additionalInstructionsTitle.trim() }
        : { kind: "missing" };

    case "admin_fitting_type":
      return ctx.adminFittingType?.trim()
        ? { kind: "text", text: ctx.adminFittingType.trim() }
        : { kind: "missing" };

    // Naming & Categories (from Google Sheets)
    case "category_name_structure":
      // Category naming helpers are optional context. Missing values should
      // prune placeholder lines instead of hard-failing the whole action.
      return ctx.categoryNameStructure?.trim()
        ? { kind: "text", text: ctx.categoryNameStructure.trim() }
        : { kind: "text", text: "" };

    case "category_name_example":
      // Category naming helpers are optional context. Missing values should
      // prune placeholder lines instead of hard-failing the whole action.
      return ctx.categoryNameExample?.trim()
        ? { kind: "text", text: ctx.categoryNameExample.trim() }
        : { kind: "text", text: "" };

    case "form_filter_context":
      // Never treat empty filter context as "missing" — some categories have no filters.
      // Return empty text so it resolves (no validation error) and the placeholder is pruned.
      return ctx.formFilterContext?.trim()
        ? { kind: "text", text: ctx.formFilterContext.trim() }
        : { kind: "text", text: "" };

    case "custom_text":
      return { kind: "missing" };

    default:
      return { kind: "missing" };
  }
}

// ── Line pruning ───────────────────────────────────────────────

function pruneLines(text: string, placeholder: string): string {
  const lines = text.split("\n");
  const filtered = lines.filter((line) => !line.includes(placeholder));
  return filtered.join("\n");
}

// ── Error messages ─────────────────────────────────────────────

const BINDING_ERROR_LABELS: Partial<Record<BindingType, string>> = {
  instruction_pdf: "Instruction PDF (upload in Admin → AI Prompts)",
  supplier_datasheet_pdf: "Supplier Datasheet PDF (Form)",
  admin_create_description_datasheet_pdf: "Admin Create Description Datasheet PDF",
  supplier_website_pdf: "Supplier Website PDF (Form)",
  compare_supplier_pdf: "Compare: Supplier Datasheet PDF",
  compare_ls_pdf: "Compare: LS Datasheet PDF",
  form_sku: "SKU (select a product first)",
  compare_optional_sku: "Compare SKU (optional)",
  form_brand: "Brand",
  form_title: "Title field",
  form_description: "Description field",
  form_main_category: "Main Category",
  form_selected_categories: "Selected Categories",
  form_ai_data_edited: "Edited AI Data field",
  form_data_text: "Form Data",
  form_specifications_summary: "Specifications / Filters",
  form_image_urls: "Image URLs",
  form_email_notes: "Email Notes",
  additional_instructions_data: "Additional Instructions (Data)",
  additional_instructions_title: "Additional Instructions (Title)",
  admin_fitting_type: "Admin Fitting Type",
  category_name_structure: "Category Name Structure (from sheet)",
  category_name_example: "Category Name Example (from sheet)",
  form_filter_context: "Filter Context",
};

function getMissingErrorMessage(variable: PromptVariable, bindingType: BindingType): string {
  const label = BINDING_ERROR_LABELS[bindingType] || variable.name;
  return `Missing required: ${label}`;
}
