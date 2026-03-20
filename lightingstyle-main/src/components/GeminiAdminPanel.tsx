import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/ui/card";
import { AlertCircle, CheckCircle2, Loader2, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  getGeminiConfig,
  updateGeminiConfig,
  performGeminiConnectionTest,
  getGeminiTestStatus,
  isGeminiConfigured,
} from "@/lib/geminiConfig";

/**
 * Gemini AI Admin Panel Component
 * 
 * Provides UI for:
 * - Enabling/disabling Gemini
 * - Testing connection
 * - Customizing extraction prompts
 * - Status display
 */

interface GeminiAdminPanelProps {
  onConfigChange?: (config: ReturnType<typeof getGeminiConfig>) => void;
}

export function GeminiAdminPanel({ onConfigChange }: GeminiAdminPanelProps) {
  const { toast } = useToast();
  const [config, setConfig] = useState(() => getGeminiConfig());
  const [testing, setTesting] = useState(false);
  const [editingPrompts, setEditingPrompts] = useState(false);

  const handleEnableChange = useCallback((enabled: boolean) => {
    updateGeminiConfig({ enabled });
    setConfig((prev) => ({ ...prev, enabled }));
    onConfigChange?.(getGeminiConfig());

    toast({
      title: enabled ? "Gemini enabled" : "Gemini disabled",
      description: enabled
        ? "AI features will be available in the product entry form"
        : "AI features are now disabled",
    });
  }, [toast, onConfigChange]);

  const handleTestConnection = useCallback(async () => {
    setTesting(true);
    try {
      const success = await performGeminiConnectionTest();
      setConfig(getGeminiConfig());

      if (success) {
        toast({
          title: "✅ Connection successful",
          description: "Gemini AI is ready to use",
        });
      } else {
        toast({
          title: "❌ Connection failed",
          description:
            "Check that GEMINI_API_KEY is set in Supabase and the function is deployed",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Test failed:", error);
      toast({
        title: "❌ Test error",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setTesting(false);
    }
  }, [toast]);

  const handleSavePrompts = useCallback(() => {
    updateGeminiConfig({ customPrompts: config.customPrompts });
    onConfigChange?.(getGeminiConfig());

    toast({
      title: "Prompts saved",
      description: "Custom extraction prompts updated",
    });
    setEditingPrompts(false);
  }, [config.customPrompts, toast, onConfigChange]);

  const testStatus = getGeminiTestStatus();
  const isConfigured = isGeminiConfigured();

  return (
    <div className="space-y-6">
      {/* Main Enable/Disable Section */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-semibold text-sm">Enable Gemini AI</h4>
            <p className="text-xs text-muted-foreground mt-1">
              Auto-extract product data from documents (PDFs, images)
            </p>
          </div>
          <Switch
            checked={config.enabled}
            onCheckedChange={handleEnableChange}
          />
        </div>
      </Card>

      {/* Connection Status */}
      <Card className="p-4 space-y-3">
        <h4 className="font-semibold text-sm">Connection Status</h4>

        <div
          className={`flex items-center gap-2 p-3 rounded-md ${
            testStatus.status === "connected"
              ? "bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800"
              : testStatus.status === "error"
                ? "bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800"
                : "bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800"
          }`}
        >
          {testStatus.status === "connected" ? (
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
          ) : testStatus.status === "error" ? (
            <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          )}
          <div className="text-xs">
            <p className="font-medium">
              {testStatus.status === "connected"
                ? "✅ Gemini API Connected"
                : testStatus.status === "error"
                  ? "❌ Connection Failed"
                  : "⚠️ Not Tested Yet"}
            </p>
            {testStatus.timestamp && (
              <p className="text-muted-foreground">
                Last tested: {testStatus.timestamp.toLocaleString()}
              </p>
            )}
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleTestConnection}
          disabled={testing}
          className="w-full"
        >
          {testing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
              Testing...
            </>
          ) : (
            <>
              <ExternalLink className="h-3.5 w-3.5 mr-2" />
              Test Connection
            </>
          )}
        </Button>

        {testStatus.status === "error" && (
          <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 p-3 rounded-md text-xs space-y-2">
            <p className="font-semibold text-red-900 dark:text-red-100">
              Troubleshooting:
            </p>
            <ul className="list-disc list-inside space-y-1 text-red-800 dark:text-red-200">
              <li>
                Verify GEMINI_API_KEY is in Supabase → Edge Functions → Secrets
              </li>
              <li>
                Redeploy ai-jobs and ai-worker Edge Functions (see setup guide)
              </li>
              <li>Check Supabase Edge Functions logs for errors</li>
              <li>
                Allow time for deployment to complete (usually 1-2 minutes)
              </li>
            </ul>
          </div>
        )}
      </Card>

      {/* Setup Guide Link */}
      <Card className="p-4 space-y-3">
        <h4 className="font-semibold text-sm">Setup Guide</h4>
        <p className="text-xs text-muted-foreground">
          For detailed setup instructions, see the complete guide:
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          asChild
          className="w-full"
        >
          <a href="/GEMINI_AI_SETUP.md" target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3.5 w-3.5 mr-2" />
            Open Gemini AI Setup Guide
          </a>
        </Button>
      </Card>

      {/* Custom Prompts Section */}
      {isConfigured && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-sm">Custom Extraction Prompts</h4>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditingPrompts(!editingPrompts)}
            >
              {editingPrompts ? "Cancel" : "Edit"}
            </Button>
          </div>

          {editingPrompts ? (
            <div className="space-y-3">
              <div>
                <Label className="text-xs font-medium">
                  Product Data Extraction Prompt
                </Label>
                <Textarea
                  value={config.customPrompts?.productData || ""}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      customPrompts: {
                        ...prev.customPrompts,
                        productData: e.target.value,
                      },
                    }))
                  }
                  placeholder="Enter custom prompt for extracting product data..."
                  className="h-20 text-xs mt-1"
                />
              </div>

              <div>
                <Label className="text-xs font-medium">
                  Specifications Extraction Prompt
                </Label>
                <Textarea
                  value={config.customPrompts?.specifications || ""}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      customPrompts: {
                        ...prev.customPrompts,
                        specifications: e.target.value,
                      },
                    }))
                  }
                  placeholder="Enter custom prompt for extracting specifications..."
                  className="h-20 text-xs mt-1"
                />
              </div>

              <div>
                <Label className="text-xs font-medium">
                  SKU & Brand Extraction Prompt
                </Label>
                <Textarea
                  value={config.customPrompts?.skuAndBrand || ""}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      customPrompts: {
                        ...prev.customPrompts,
                        skuAndBrand: e.target.value,
                      },
                    }))
                  }
                  placeholder="Enter custom prompt for extracting SKU and brand..."
                  className="h-20 text-xs mt-1"
                />
              </div>

              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleSavePrompts}
                className="w-full"
              >
                Save Prompts
              </Button>
            </div>
          ) : (
            <div className="space-y-2 text-xs">
              <div className="bg-muted p-2 rounded font-mono text-muted-foreground">
                <p className="line-clamp-2">
                  {config.customPrompts?.productData ||
                    "Default: Extract product data"}
                </p>
              </div>
              <p className="text-muted-foreground">
                Click "Edit" to customize the prompts Gemini uses to extract
                data from documents.
              </p>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
