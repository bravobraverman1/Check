# Google Sheets Setup Checklist

Use this checklist to ensure you've completed all steps to link your Google Sheets.

## ✅ STEP 1: Create Google Service Account

- [ ] Created a Google Cloud project
- [ ] Created a Service Account in Google Cloud Console
- [ ] Downloaded the Service Account JSON key file
- [ ] **Kept the JSON key file secure** (never commit to version control)

## ✅ STEP 2: Share Your Google Sheet

- [ ] Copied the service account email from JSON file (`client_email` field)
- [ ] Shared your Google Sheet with the service account email as **Editor**
- [ ] Copied your Google Sheet ID from the URL

## ✅ STEP 3: Configure Your Credentials

Choose **one** of these options:

### Option A: Browser-Based Configuration (Quickest to Start)
- [ ] Opened your application and navigated to the **Admin** tab
- [ ] Pasted the Service Account JSON key contents
- [ ] Entered your Google Sheet ID
- [ ] Clicked **Test Connection** successfully
- [ ] Clicked **Save Connection Settings**

### Option B: Server-Side Configuration (For Production)
- [ ] Opened Supabase project dashboard
- [ ] Navigate to **Edge Functions** → **Secrets** in the left sidebar
- [ ] Added `GOOGLE_SERVICE_ACCOUNT_KEY` secret (entire JSON key contents)
- [ ] Added `GOOGLE_SHEET_ID` secret
- [ ] Proceeded to STEP 4

## ✅ STEP 4: Deploy the Edge Function (Server-Side Only)

**Skip if using Option A above.**

- [ ] Confirmed Edge Function is deployed to Supabase (visible in Dashboard → Edge Functions)
- [ ] Set up GitHub Secrets (see STEP 5 below)

## ✅ STEP 5: Activate Google Sheets Connection (GitHub Actions)

This step activates your connection. **No terminal required—just click!**

### Prepare GitHub Secrets (One-time)
- [ ] Go to GitHub Repository → **Settings** → **Secrets and variables** → **Actions**
- [ ] Added `SUPABASE_ACCESS_TOKEN` secret
  - Get from: https://supabase.com/dashboard/account/tokens
- [ ] Added `SUPABASE_PROJECT_REF` secret
  - Get from: Supabase Dashboard → Project Settings → Reference ID
- [ ] Added `SUPABASE_DB_PASSWORD` secret
  - Your Supabase database password

### Run the Activation Workflow
- [ ] Opened GitHub Repository → **Actions** tab
- [ ] Selected **"Deploy Google Sheets Connection"** from the left sidebar
- [ ] Clicked **"Run workflow"** button
- [ ] Waited for workflow to complete (green checkmark ✓)

### Verify the Connection
- [ ] Returned to your application's **Admin** page
- [ ] Clicked **"Test Connection"** button
- [ ] Saw confirmation that connection is active
- [ ] Verified actual SKU data loads (not mock data)

## ✅ Sheet Structure

Verify your Google Sheet has these tabs (names are configurable in Admin panel):

- [ ] **PRODUCTS TO DO** - Products to process (SKU, Brand, Status, Visibility)
- [ ] **Categories** - Category hierarchy paths
- [ ] **BRANDS** - Brand and supplier information
- [ ] **PROPERTIES** - Custom field definitions
- [ ] **LEGAL** - Allowed values for dropdown fields
- [ ] **OUTPUT** - Where completed product data is written
- [ ] **FILTER** (optional) - Field visibility rules per category

## ✅ Admin Panel Configuration

- [ ] Set Sheet Tab Names to match your actual Google Sheet tabs
- [ ] Verified Categories are loaded correctly
- [ ] Reviewed LEGAL values for dropdown fields
- [ ] Tested loading a product from SKU Selector

## 🆘 Troubleshooting

### GitHub Actions Workflow Failed

1. **Check the workflow logs:**
   - Go to **Actions** tab → **Deploy Google Sheets Connection** → Click the failed run
   - Scroll down to see error messages

2. **Verify GitHub Secrets are set:**
   - Settings → Secrets and variables → Actions
   - Confirm all three secrets are present:
     - `SUPABASE_ACCESS_TOKEN`
     - `SUPABASE_PROJECT_REF`
     - `SUPABASE_DB_PASSWORD`

3. **Verify secret values:**
   - `SUPABASE_ACCESS_TOKEN` should start with `sbp_...`
   - `SUPABASE_PROJECT_REF` should be your project ID (e.g., `abcdefghijklmnop`)
   - `SUPABASE_DB_PASSWORD` should be your actual database password

### Connection Test Fails

1. **Browser-Based Config (Option A):**
   - Navigate to Admin tab and re-enter credentials
   - Ensure JSON key is complete (check file wasn't truncated)
   - Verify service account has Editor access to your sheet

2. **Server-Side Config (Option B):**
   - Verify `GOOGLE_SERVICE_ACCOUNT_KEY` is set correctly in Supabase
   - Check `GOOGLE_SHEET_ID` matches your actual sheet ID
   - Run the workflow again if secrets were just added

### Data Not Loading

1. Check browser console (F12) for JavaScript errors
2. Verify your sheet tab names match the configuration in Admin panel
3. Ensure header rows exist and data starts from row 2
4. Confirm the service account email has Editor access to the sheet

## 📚 Resources

- [Complete Setup Guide](./GOOGLE_SHEETS_SETUP.md) - Detailed instructions for all steps
- [GitHub Actions Configuration](../.github/README.md) - Information about the workflows
- [Google Cloud Console](https://console.cloud.google.com/) - For service account creation
- [Supabase Dashboard](https://supabase.com/dashboard) - For secrets and Edge Functions
- [GitHub Secrets Documentation](https://docs.github.com/en/actions/security-guides/encrypted-secrets) - How to manage GitHub Secrets

## 🔒 Security Reminders

- [ ] Service account JSON key is **never** committed to version control
- [ ] GitHub Secrets are encrypted and not visible in logs
- [ ] Credentials are stored securely in Supabase
- [ ] Regular key rotation recommended (every 90 days)

---

**Need more help?** See the complete documentation in [GOOGLE_SHEETS_SETUP.md](./GOOGLE_SHEETS_SETUP.md)

