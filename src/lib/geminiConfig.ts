import { getConfigValue, setConfigValue } from "@/config";
import { testGeminiConnection } from "@/lib/geminiAI";
import { AI_ENFORCED_MODEL } from "@/lib/aiPipelineConstants";

/**
 * Gemini AI Configuration & Admin Panel Integration
 * 
 * This module handles:
 * - Enabling/disabling Gemini features
 * - Testing Gemini connection
 * - Configuring extraction prompts
 * - Admin UI rendering
 */

export interface GeminiConfig {
  enabled: boolean;
  model: string;
  lastTestTime?: number;
  testResult?: "success" | "error" | null;
  customPrompts?: {
    productData?: string;
    specifications?: string;
    skuAndBrand?: string;
  };
}

/** Available Gemini models — only shown if GEMINI_API_KEY is configured */
export const GEMINI_MODELS = [
  { id: AI_ENFORCED_MODEL, label: "Gemini 3 Flash (Production)", description: "Fastest — built for speed, paid tier" },
] as const;

export const DEFAULT_GEMINI_MODEL = AI_ENFORCED_MODEL;

/**
 * Get current Gemini configuration
 */
export function getGeminiConfig(): GeminiConfig {
  const storedModel = getConfigValue("GEMINI_MODEL", DEFAULT_GEMINI_MODEL);
  const model = GEMINI_MODELS.some((m) => m.id === storedModel)
    ? storedModel
    : DEFAULT_GEMINI_MODEL;

  if (model !== storedModel) {
    setConfigValue("GEMINI_MODEL", DEFAULT_GEMINI_MODEL);
  }

  return {
    enabled: getConfigValue("GEMINI_ENABLED", "true") === "true",
    model,
    lastTestTime: parseInt(
      getConfigValue("GEMINI_LAST_TEST", "0")
    ),
    testResult: (getConfigValue("GEMINI_TEST_RESULT", null) as "success" | "error" | null),
    customPrompts: {
      productData: getConfigValue(
        "GEMINI_PROMPT_PRODUCT",
        "Extract product SKU, brand, and specifications"
      ),
      specifications: getConfigValue(
        "GEMINI_PROMPT_SPECS",
        "Extract all technical specifications"
      ),
      skuAndBrand: getConfigValue(
        "GEMINI_PROMPT_SKU_BRAND",
        "Extract SKU and brand name"
      ),
    },
  };
}

/**
 * Update Gemini configuration
 */
export function updateGeminiConfig(config: Partial<GeminiConfig>): void {
  if (config.enabled !== undefined) {
    setConfigValue("GEMINI_ENABLED", config.enabled ? "true" : "false");
  }
  if (config.model !== undefined) {
    const normalized = GEMINI_MODELS.some((m) => m.id === config.model)
      ? config.model
      : DEFAULT_GEMINI_MODEL;
    setConfigValue("GEMINI_MODEL", normalized);
  }
  if (config.customPrompts) {
    if (config.customPrompts.productData) {
      setConfigValue("GEMINI_PROMPT_PRODUCT", config.customPrompts.productData);
    }
    if (config.customPrompts.specifications) {
      setConfigValue("GEMINI_PROMPT_SPECS", config.customPrompts.specifications);
    }
    if (config.customPrompts.skuAndBrand) {
      setConfigValue("GEMINI_PROMPT_SKU_BRAND", config.customPrompts.skuAndBrand);
    }
  }
}

/**
 * Save Gemini test result
 */
export function saveGeminiTestResult(success: boolean): void {
  setConfigValue("GEMINI_LAST_TEST", Date.now().toString());
  setConfigValue("GEMINI_TEST_RESULT", success ? "success" : "error");
}

/**
 * Test Gemini connection and save result
 */
export async function performGeminiConnectionTest(): Promise<boolean> {
  try {
    const connected = await testGeminiConnection();
    saveGeminiTestResult(connected);
    return connected;
  } catch (error) {
    console.error("Gemini test error:", error);
    saveGeminiTestResult(false);
    return false;
  }
}

/**
 * Get formatted test status for display
 */
export function getGeminiTestStatus(): {
  status: "connected" | "error" | "not-tested";
  message: string;
  timestamp?: Date;
} {
  const config = getGeminiConfig();

  if (!config.testResult) {
    return {
      status: "not-tested",
      message: "Connection not tested yet",
    };
  }

  if (config.testResult === "success") {
    return {
      status: "connected",
      message: "✅ Gemini AI connected and ready",
      timestamp: config.lastTestTime ? new Date(config.lastTestTime) : undefined,
    };
  }

  return {
    status: "error",
    message: "❌ Gemini AI connection failed",
    timestamp: config.lastTestTime ? new Date(config.lastTestTime) : undefined,
  };
}

/**
 * Check if Gemini is fully configured
 */
export function isGeminiConfigured(): boolean {
  const config = getGeminiConfig();
  return config.enabled && config.testResult === "success";
}

/**
 * Get help text for Admin panel
 */
export function getGeminiHelpText(): string {
  return `
Gemini AI Integration

Once enabled and connected, you can:
- Upload product documents (PDFs, images)
- Auto-extract SKU, brand, and specifications
- Populate form fields automatically

Setup required:
1. Add GEMINI_API_KEY to Supabase → Edge Functions → Secrets
2. Deploy ai-jobs + ai-worker Edge Functions (via GitHub Actions)
3. Create document-uploads storage bucket
4. Test connection below

See GEMINI_AI_SETUP.md for detailed setup guide.
  `.trim();
}
