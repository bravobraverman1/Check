# How to Add Gemini AI to Your App

This document shows exactly where to add the new Gemini components to your existing Product Entry Hub.

## ✅ Prerequisites

Before starting, complete these steps:

1. ✅ Get GEMINI_API_KEY (see `GEMINI_AI_SETUP.md` Step 1)
2. ✅ Add to Supabase Secrets (see `GEMINI_AI_SETUP.md` Step 2)
3. ✅ Deploy Edge Function (see `GEMINI_AI_SETUP.md` Step 3)
4. ✅ Create Storage Bucket (see `GEMINI_AI_SETUP.md` Step 4)

> These steps take ~15 minutes total and are required for any of this to work.

---

## Adding Gemini to Admin Panel

### Step 1: Import in Admin.tsx

**File**: `src/pages/Admin.tsx`

Find the import section at the top. Add this line:

```typescript
import { GeminiAdminPanel } from "@/components/GeminiAdminPanel";
```

### Step 2: Add the Component

**File**: `src/pages/Admin.tsx`

Find this section (around line 750-800):

```tsx
{/* FILTER Rules Editor */}
<FormSection title="FILTER Rules Editor" defaultOpen={false}>
  {/* ... existing code ... */}
</FormSection>
```

**Add this AFTER it:**

```tsx
{/* Gemini AI Configuration */}
<FormSection title="Gemini AI Setup" defaultOpen={false}>
  <div className="space-y-3">
    <p className="text-xs text-muted-foreground">
      Configure Google Gemini AI for automatic document scanning and data extraction.
    </p>
    <GeminiAdminPanel />
  </div>
</FormSection>
```

**That's it!** Now your Admin panel has:
- ✅ Enable/disable toggle for Gemini
- ✅ Test connection button
- ✅ Custom prompt editor
- ✅ Status display with troubleshooting

---

## Adding Document Upload to Product Form

### Step 1: Import in ProductEntryForm.tsx

**File**: `src/components/ProductEntryForm.tsx`

Find the import section at the top, add:

```typescript
import { DocumentUpload } from "@/components/DocumentUpload";
```

### Step 2: Add the Component to Form

**File**: `src/components/ProductEntryForm.tsx`

Find this section (around line 480-560):

```tsx
{/* Specifications */}
<FormSection title="Specifications" defaultOpen={false}>
  {/* ... existing code ... */}
</FormSection>
```

**Add this BEFORE the Specifications section:**

```tsx
{/* AI Document Upload */}
{isGeminiConfigured && (
  <DocumentUpload 
    onDataExtracted={(data) => {
      // Auto-fill form fields from extracted data
      if (data.sku) setMainSku(data.sku);
      if (data.brand) setSelectedBrand(data.brand);
      if (data.diameter) setSpecs({ ...specs, diameter: data.diameter });
      if (data.height) setSpecs({ ...specs, height: data.height });
      if (data.width) setSpecs({ ...specs, width: data.width });
      if (data.depth) setSpecs({ ...specs, depth: data.depth });
      if (data.beamAngle) setSpecs({ ...specs, beamAngle: data.beamAngle });
      if (data.colourTemp) setSpecs({ ...specs, colourTemp: data.colourTemp });
      if (data.mounting) setSpecs({ ...specs, mounting: data.mounting });
      if (data.ipRating) setSpecs({ ...specs, ipRating: data.ipRating });
      
      toast({
        title: "Form Updated",
        description: "Extracted data auto-filled in form"
      });
    }}
  />
)}
```

### Step 3: Add Helper Function (Optional)

At the top of `ProductEntryForm.tsx`, add:

```typescript
import { isGeminiConfigured } from "@/lib/geminiConfig";

// In component body:
const isGeminiConfigured = isGeminiConfigured();
```

**That's it!** Now your product form has:
- ✅ Upload button for documents
- ✅ Auto-extraction of product data
- ✅ Auto-fill form fields
- ✅ Error handling and feedback

---

## How It All Connects

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Product Entry Hub                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────┐                       │
│  │      Admin Panel                 │                       │
│  ├──────────────────────────────────┤                       │
│  │ ☐ Enable Gemini                 │  ← GeminiAdminPanel   │
│  │ [Test Connection] ✅ Connected  │  ← Config & testing   │
│  │ [Edit Prompts]                  │                       │
│  └──────────────────────────────────┘                       │
│            │                                                 │
│            │ stores config                                   │
│            ↓                                                 │
│  ┌──────────────────────────────────┐                       │
│  │  geminiConfig.ts                 │                       │
│  │  (Config management)             │                       │
│  └──────────────────────────────────┘                       │
│            ↓                                                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────┐                       │
│  │   Product Entry Form              │                      │
│  ├──────────────────────────────────┤                       │
│  │ [📁 Upload Document]             │  ← DocumentUpload    │
│  │ ⚙️ Processing...                 │  ← Shows when        │
│  │ ✅ Extracted SKU: ABC123         │    enabled           │
│  │ ✅ Extracted Brand: Acme         │                       │
│  │ (form auto-fills)                │                       │
│  └──────────────────────────────────┘                       │
│            │                                                 │
│            │ calls                                            │
│            ↓                                                 │
│  ┌──────────────────────────────────┐                       │
│  │  geminiAI.ts                      │                      │
│  │  Frontend → Edge Function         │                      │
│  └──────────────────────────────────┘                       │
│            │                                                 │
│            │ calls via supabase.functions.invoke()          │
│            ↓                                                 │
├─────────────────────────────────────────────────────────────┤
│                    SUPABASE (Server-side)                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────┐                       │
│  │  Edge Function                    │                      │
│  │  gemini-processor                 │                      │
│  ├──────────────────────────────────┤                       │
│  │ 1. Receive document from frontend │                      │
│  │ 2. Get API key from Secrets       │                      │
│  │ 3. Call Gemini                    │                      │
│  │ 4. Return results                 │                      │
│  └──────────────────────────────────┘                       │
│            │                                                 │
│            │ uses secret key                                 │
│            ↓                                                 │
│  ┌──────────────────────────────────┐                       │
│  │  Supabase Secrets Vault           │                      │
│  │  GEMINI_API_KEY = ***secret***   │                      │
│  └──────────────────────────────────┘                       │
│            │                                                 │
│            │ calls API with key                              │
│            ↓                                                 │
│  ┌──────────────────────────────────┐                       │
│  │  Google Gemini API                │                      │
│  │  (Cloud service)                  │                      │
│  └──────────────────────────────────┘                       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Testing Your Setup

### Test 1: Admin Panel

1. Go to Admin page
2. Find **"Gemini AI Setup"** section
3. See the interface with Enable toggle
4. Click **"Test Connection"**
5. Should show: ✅ "Gemini API Connected"

**If you see ❌ Connection Failed:**
- Check `GEMINI_AI_SETUP.md` troubleshooting section
- Verify API key in Supabase
- Check if Edge Function deployed

### Test 2: Document Upload

1. Go to Product Entry Form
2. Look for **"AI Document Scan"** section (blue box)
3. Upload a PDF or image with product info
4. Select extraction mode (Full Data or SKU & Brand)
5. Click **"Extract Data"**
6. Should show extracted fields and auto-fill form

**If upload button doesn't show:**
- Check Admin panel - enable Gemini
- Test connection first

**If extraction returns no data:**
- Document might not have readable text
- Try clearer image or different document
- Check browser console (F12) for errors

### Test 3: Error Handling

Try these to verify error handling works:

- Upload file > 10MB → "File too large" message
- Upload TIFF file → "Invalid file type" message
- Disable Gemini in Admin → upload button hides
- Disconnect Gemini → shows error message

---

## Configuration Reference

### In Admin Panel

**Enable Gemini**
- Toggle in GeminiAdminPanel
- Stores in browser localStorage

**Test Connection**
- Calls testGeminiConnection()
- Shows status: ✅ Connected or ❌ Failed

**Custom Prompts**
- Edit what Gemini extracts
- Save to localStorage
- Used for all extractions

### In ProductEntryForm

**Data Mapping**
```typescript
// When document is uploaded and data extracted:
if (data.sku) setMainSku(data.sku);           // → SKU field
if (data.brand) setSelectedBrand(data.brand); // → Brand field
if (data.height) setSpecs({...specs, height: data.height}); // → Height
// ... etc for other fields
```

---

## Environment Variables Needed

You already have these from Google Sheets setup:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...
```

**New for Gemini:**

```
GEMINI_API_KEY=AIzaSy...    # In Supabase Secrets (not in .env!)
```

---

## Optional: Customize Extraction

Want to extract different fields? Edit in Admin Panel:

**Example for lighting products:**

```
Extract these fields from the lighting product document:
1. SKU/Model number
2. Brand
3. Wattage (W)
4. Lumens (lm)
5. Colour temperature (Kelvin)
6. Beam angle (degrees)
7. Mounting method
8. Materials
9. Warranty years

Return as JSON:
{
  "sku": "product code",
  "brand": "manufacturer",
  "wattage": "value in W",
  "lumens": "value in lm",
  "colour_temp": "value in K",
  "beam_angle": "value in degrees",
  "mounting": "type",
  "materials": "list",
  "warranty": "years"
}
```

Then update the form field mapping to match!

---

## Troubleshooting Common Issues

### Issue: "Button not showing in product form"

**Cause**: Gemini not enabled or test failed

**Fix**:
1. Go to Admin → Gemini AI Setup
2. Toggle Enable
3. Click "Test Connection"
4. Should show ✅ Connected
5. Button will appear in form

### Issue: "Upload button shows but nothing happens"

**Cause**: Network error or API key issue

**Fix**:
1. Open browser console (F12)
2. Try uploading again
3. Look for error messages
4. Check `GEMINI_AI_SETUP.md` troubleshooting

### Issue: "Extracted data doesn't match form fields"

**Cause**: Field mapping in ProductEntryForm doesn't match extraction

**Fix**:
1. Check what fields DocumentUpload sends
2. Update mapping in ProductEntryForm.tsx
3. Ensure field names match your form
4. Test with known document

### Issue: "Edge Function says 'API key not configured'"

**Cause**: GEMINI_API_KEY not in Supabase Secrets

**Fix**:
1. Go to Supabase dashboard
2. Settings → Secrets and Vault
3. Add new secret: `GEMINI_API_KEY`
4. Paste your Gemini API key
5. Redeploy Edge Function
6. Test again

---

## Done! 🎉

You now have:
- ✅ Gemini AI enabled in Admin panel
- ✅ Document upload in product form
- ✅ Auto-extraction of product data
- ✅ Auto-fill form fields
- ✅ Error handling and user feedback
- ✅ Secure server-side processing

All the hard work is done. Just integrate the components and you're ready to go!

For detailed setup, see: `GEMINI_AI_SETUP.md`
For implementation status, see: `GEMINI_IMPLEMENTATION_CHECKLIST.md`
