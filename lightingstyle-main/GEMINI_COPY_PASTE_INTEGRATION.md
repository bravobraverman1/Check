# Gemini AI Integration Guide — Copy-Paste Implementation

**This guide shows EXACT locations and copy-paste code for adding Gemini to your app.**

---

## File Overview

After setup (GEMINI_SETUP_PRODUCTION.md), these files are already created:

✅ **Edge Function** (deployed via GitHub Actions)
- `supabase/functions/gemini-processor/index.ts`

✅ **Frontend Library** (already in your codebase)
- `src/lib/geminiAI.ts` - API calls to the Edge Function
- `src/lib/geminiConfig.ts` - Configuration management

✅ **UI Components** (already in your codebase)
- `src/components/GeminiAdminPanel.tsx` - Admin settings & test connection
- `src/components/DocumentUpload.tsx` - File upload & extraction

**Your job: Add the components to your app with 3 copy-paste steps**

---

## Step 1: Add Gemini Admin Panel to Admin Page

### File: `src/pages/Admin.tsx`

Find the import section at the top and add:

```typescript
import { GeminiAdminPanel } from "@/components/GeminiAdminPanel";
```

Then, find the section with "FILTER Rules Editor" or similar, and add this component after it:

```tsx
{/* Gemini AI Configuration */}
<GeminiAdminPanel />
```

**Example location** (search for "FILTER" in your Admin.tsx):

```typescript
// BEFORE: Your existing code
<FilterRulesEditor />

// AFTER: Add this
{/* Gemini AI Configuration */}
<GeminiAdminPanel />
```

---

## Step 2: Add Document Upload to Product Entry Form

### File: `src/components/ProductEntryForm.tsx`

Find the import section and add:

```typescript
import { DocumentUpload } from "@/components/DocumentUpload";
import { isGeminiConfigured } from "@/lib/geminiConfig";
```

Then, find where you have "Specifications" section (search for "Specifications" or "SpecificationsInputs") and add this BEFORE it:

```tsx
{/* Document Upload (Gemini AI) */}
{isGeminiConfigured() && <DocumentUpload onDataExtracted={handleExtractedData} />}
```

### Also add this handler function in the same file:

```typescript
/**
 * Handles extracted data from Gemini AI document processing
 */
const handleExtractedData = (extractedData: {
  sku?: string;
  brand?: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
}) => {
  // Auto-fill form fields from extracted data
  if (extractedData.sku) {
    // Find your SKU input field and set its value
    // Example (adjust to your form structure):
    const skuInput = document.querySelector('input[name="sku"]') as HTMLInputElement;
    if (skuInput) skuInput.value = extractedData.sku;
  }
  
  if (extractedData.brand) {
    // Find your Brand select field and set its value
    const brandSelect = document.querySelector('select[name="brand"]') as HTMLSelectElement;
    if (brandSelect) brandSelect.value = extractedData.brand;
  }
  
  // Add more field mappings as needed
  if (extractedData.description) {
    const descInput = document.querySelector('textarea[name="description"]') as HTMLTextAreaElement;
    if (descInput) descInput.value = extractedData.description;
  }
};
```

**Example location** (search for "Specifications" or similar):

```typescript
// BEFORE: Your existing code
<SpecificationsInputs properties={properties} />

// AFTER: Add this
{/* Document Upload (Gemini AI) */}
{isGeminiConfigured() && <DocumentUpload onDataExtracted={handleExtractedData} />}

<SpecificationsInputs properties={properties} />
```

---

## Step 3: Optional - Customize Extraction Prompts

The app comes with default prompts, but you can customize them in the Admin panel:

1. Open your app → **Admin** page
2. Scroll to **"Gemini AI"** section
3. Click **"Custom Extraction Prompt"** to expand
4. Edit the prompt text
5. Click **"Save Settings"**

**Default prompts:**

**Full Data Extraction:**
```
Extract ALL product information from this document and return as JSON with these fields:
- sku: Product SKU/ID
- brand: Brand/Manufacturer name
- name: Product name or model
- description: Brief product description
- specifications: Key specs (temperature range, power, dimensions, etc.)
- features: Main features/benefits as a list
- price: Price if found
Format as valid JSON. Include only fields found in the document.
```

**Quick SKU + Brand:**
```
Extract from this document:
1. Product SKU/ID or model number
2. Brand or manufacturer name
Return as JSON: { "sku": "...", "brand": "..." }
```

---

## Testing After Integration

### Test 1: Check Admin Panel

1. Go to **Admin** page
2. Look for **"Gemini AI"** section (grey box)
3. Click **"Test Connection"** button
4. Should show green **"✓ Gemini API Connected"**

### Test 2: Upload a Document

1. Go to **Product Entry Form**
2. Look for **"📁 AI Document Scan"** section (NEW - added in Step 2)
3. Click upload area or select a file (PDF or image)
4. Choose extraction mode:
   - **Full Data**: Extract all product info
   - **SKU + Brand**: Just extract SKU and brand
5. Click **"Extract Data"**
6. Form fields should auto-fill with extracted data

### Test 3: Verify Auto-Fill

1. Upload a product datasheet or image
2. Check that:
   - SKU field fills automatically
   - Brand field fills automatically
   - Description field fills (if extraction includes it)
3. Review and edit any fields as needed
4. Save the product

---

## Troubleshooting During Integration

### "GeminiAdminPanel not found" or "Cannot find module"

**Problem:** Component import not working.

**Solution:**
1. Verify file exists: `ls src/components/GeminiAdminPanel.tsx`
2. Check import path in Admin.tsx - should be `@/components/GeminiAdminPanel`
3. Make sure you added the import at the TOP of the file

### "DocumentUpload not found" or "Cannot find module"

**Problem:** Component import not working.

**Solution:**
1. Verify file exists: `ls src/components/DocumentUpload.tsx`
2. Check import path in ProductEntryForm.tsx - should be `@/components/DocumentUpload`
3. Make sure you added the import at the TOP of the file

### "isGeminiConfigured is not a function"

**Problem:** Missing config import.

**Solution:**
Make sure you imported: `import { isGeminiConfigured } from "@/lib/geminiConfig";`

### Component shows but "Test Connection" fails

**Problem:** API key not set up.

**Solution:**
1. Go back to GEMINI_SETUP_PRODUCTION.md
2. Complete STEP 1-4 (get API key, add to Supabase, run GitHub Actions)
3. Wait 2-3 minutes after GitHub Actions completes
4. Try the test again

### Document upload button doesn't appear

**Problem:** Gemini not configured yet.

**Solution:**
The button only shows if `isGeminiConfigured()` returns true. This happens after:
1. You test the connection successfully in Admin panel
2. Settings are saved to localStorage

Try:
1. Go to Admin → Gemini AI section
2. Click "Test Connection"
3. Refresh the page
4. Go back to Product Entry Form - button should appear now

---

## Customization Examples

### Example 1: Extract Only Specific Fields

Edit the custom prompt in Admin panel to something like:

```
Extract ONLY these fields from the product document:
- sku: Product model number or SKU
- brand: Manufacturer
Return as: { "sku": "...", "brand": "..." }
Do not include any other fields.
```

### Example 2: Format Extracted Data

Modify `handleExtractedData` to transform data:

```typescript
const handleExtractedData = (extractedData: any) => {
  // Uppercase SKU
  if (extractedData.sku) {
    extractedData.sku = extractedData.sku.toUpperCase();
  }
  
  // Add prefix to brand if missing
  if (extractedData.brand && !extractedData.brand.includes("Inc")) {
    extractedData.brand = `${extractedData.brand} Inc`;
  }
  
  // Fill form fields
  // ... rest of your code
};
```

### Example 3: Add Validation Before Auto-Fill

```typescript
const handleExtractedData = (extractedData: any) => {
  // Only auto-fill if confidence is high
  if (extractedData.sku && extractedData.sku.length > 2) {
    const skuInput = document.querySelector('input[name="sku"]') as HTMLInputElement;
    if (skuInput) skuInput.value = extractedData.sku;
  }
  // ... more validation
};
```

---

## File Reference

### Already Created Files (Nothing to do!)

**`src/lib/geminiAI.ts`**
- Functions: `callGeminiProcessor()`, `extractProductData()`, `extractSkuAndBrand()`, `testGeminiConnection()`
- Call the Edge Function with prompts and documents
- Returns structured data (JSON or text)

**`src/lib/geminiConfig.ts`**
- Functions: `getGeminiConfig()`, `updateGeminiConfig()`, `isGeminiConfigured()`, `performGeminiConnectionTest()`
- Manages configuration in localStorage
- Persists custom prompts and settings

**`src/components/GeminiAdminPanel.tsx`**
- Toggles Gemini enable/disable
- "Test Connection" button
- Custom prompt editor
- Configuration persistence
- Status display

**`src/components/DocumentUpload.tsx`**
- File dropzone
- Document upload to Supabase Storage
- Extraction mode selector
- Auto-fills form with `onDataExtracted` callback
- Shows progress and errors

### You Will Edit

**`src/pages/Admin.tsx`**
- Add GeminiAdminPanel import
- Add component in JSX

**`src/components/ProductEntryForm.tsx`**
- Add DocumentUpload import
- Add component in JSX
- Add `handleExtractedData` function

---

## Architecture Overview

```
Product Entry Form
    ↓
DocumentUpload Component (file upload UI)
    ↓
Supabase Storage (temporary file storage)
    ↓
Edge Function: gemini-processor
    ↓
Google Gemini API (AI processing)
    ↓
Edge Function returns extracted data
    ↓
Form auto-fills via handleExtractedData()
```

**All API keys stay on the server** (Edge Function). Frontend never sees them.

---

## Next Steps

1. ✅ Complete GEMINI_SETUP_PRODUCTION.md for backend setup
2. ✅ Follow this guide for frontend integration (3 copy-paste steps)
3. ✅ Test admin connection
4. ✅ Test document upload in product form
5. ✅ Customize extraction prompts as needed
6. 🚀 Start using AI-powered product entry!

---

## Common Questions

**Q: Can I use custom prompts from the cloud?**
A: Yes! Edit the prompt in Admin panel → Gemini AI section. It's saved to localStorage and used for all extractions.

**Q: What file formats does it support?**
A: PDFs and images (JPEG, PNG, GIF, WebP). Text files also work.

**Q: How big can files be?**
A: Recommended max 10MB. Google Gemini API has size limits.

**Q: Can I switch between extraction modes?**
A: Yes! DocumentUpload shows radio buttons for different modes:
- Full Data: All product details
- SKU + Brand: Quick extraction

**Q: What if extraction fails?**
A: DocumentUpload shows error message. Check:
1. File is valid (PDF or image)
2. File size < 10MB
3. Gemini connection is working (test in Admin)
4. Custom prompt is clear and specific

---

## Getting Help

**For setup issues:** See GEMINI_SETUP_PRODUCTION.md → Troubleshooting

**For integration issues:** Check this guide's "Troubleshooting During Integration" section

**For custom prompts:** Test in Admin panel first, then adjust based on results

You're all set! 🎉
