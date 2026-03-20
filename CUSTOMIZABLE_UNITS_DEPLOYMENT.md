# Customizable Units - Deployment Guide

The code for customizable units has been updated, but you need to deploy the changes to see them in action.

## 🚨 Critical: Edge Function Must Be Redeployed

The main change was made to the Supabase Edge Function, which currently runs the **old version** in your Supabase project. You must redeploy it.

---

## Step-by-Step Deployment

### Step 1: Update Your Google Sheet (LEGAL Tab)

Add units in parentheses to your property names:

**Before:**
```
Column A (Property Name) | Column B+ (Values)
--------------------------|-------------------
Beam Angle               | 15° | 24° | 36° | ...
Height                   | (empty - text input)
Air Movement             | (empty - text input)
```

**After:**
```
Column A (Property Name) | Column B+ (Values)
--------------------------|-------------------
Beam Angle (°)           | 15° | 24° | 36° | ...
Height (mm)              | (empty - text input)
Air Movement (m³/h)      | (empty - text input)
Width (mm)               | (empty - text input)
Diameter (mm)            | (empty - text input)
```

**How it works:**
- The text in parentheses `(°)` or `(mm)` will be extracted and shown in grey next to the input field
- If no parentheses, no unit will be displayed
- Works for dropdowns and text inputs

---

### Step 2: Deploy Edge Function to Supabase

**Option A: Using GitHub Actions (Recommended)**

1. Go to your GitHub repository
2. Click **Actions** tab
3. Click **"Deploy Google Sheets Connection"** workflow in the left sidebar
4. Click **"Run workflow"** dropdown
5. Select **"production"** branch
6. Click **"Run workflow"** button
7. Wait 2-3 minutes for deployment to complete

**Option B: Using Supabase CLI (Manual)**

```bash
# Install Supabase CLI if not installed
npm install -g supabase

# Login to Supabase
supabase login

# Link to your project (get project ref from Supabase dashboard)
supabase link --project-ref YOUR_PROJECT_REF

# Deploy the edge function
supabase functions deploy google-sheets
```

---

### Step 3: Clear Cache and Refresh

After deploying the edge function:

1. Open your admin panel in the app
2. Go to **Google Sheets Connection** section
3. Click the **"Force Refresh Data"** button (new button next to "Test Connection")
4. This clears the 30-second cache immediately

**Or wait 30 seconds** - the cache will expire automatically

---

### Step 4: Test the Changes

1. Go to the product entry form
2. Look at the "Filters" section
3. You should now see:
   - **Beam Angle (°)** with "°" in grey next to the dropdown
   - **Height (mm)** with "mm" in grey next to the input
   - **Air Movement (m³/h)** with "m³/h" in grey next to the input
   - Any other fields with units you defined in the Google Sheet

---

## Troubleshooting

### Units still showing "mm" everywhere

**Problem:** Old edge function is still running

**Solution:**
1. Verify you deployed the edge function (Step 2 above)
2. Check Supabase dashboard → Edge Functions → google-sheets → make sure it shows a recent deployment
3. Click "Force Refresh Data" in Admin panel

### Units not showing at all

**Problem:** Property names in Google Sheet don't have units in parentheses

**Solution:**
1. Open your Google Sheet
2. Go to LEGAL tab
3. Edit Column A to add units in parentheses: `Property Name (unit)`
4. Save
5. Click "Force Refresh Data" in Admin panel

### Preview build error

**Problem:** Local code changes haven't been pushed/deployed to your hosting

**Solution:**
1. The preview builds from your hosted code (Lovable/Vercel)
2. Push your local changes to the repository
3. Trigger a new deployment in Lovable/Vercel
4. Wait for build to complete

---

## What Changed in the Code

### 1. Edge Function (`supabase/functions/google-sheets/index.ts`)
- Removed hardcoded `unitSuffix: "mm"`
- Property names now flow through with their units in parentheses

### 2. Frontend (`src/components/DynamicSpecifications.tsx`)
- Already had unit extraction logic (no changes needed)
- Extracts units from property names like "Height (mm)" → displays "mm"

### 3. Default Properties (`src/data/defaultProperties.ts`)
- Updated fallback data to use parentheses format
- Example: "Beam Angle" → "Beam Angle (°)"

### 4. Admin Panel (`src/pages/Admin.tsx`)
- Added "Force Refresh Data" button to clear cache immediately

---

## Examples of Customizable Units

You can use any unit you want - just add it in parentheses:

```
Property Name (unit)
--------------------
Beam Angle (°)
Height (mm)
Width (mm)
Diameter (mm) 
Air Movement (m³/h)
Fan Cutout (cm)
Temperature (°C)
Lumens (lm)
Power (W)
Weight (kg)
Voltage (V)
Current (A)
Length (m)
Suspension (mm)
Drop Height (mm)
```

The system automatically extracts what's in the parentheses and displays it in grey next to the input field!
