# STEP 5 Quick Reference: GitHub Actions Activation

## Activate Your Google Sheets Connection in 5 Clicks

> ✓ No terminal required  
> ✓ No software installation  
> ✓ No code editing  
> ✓ Completely safe to repeat  

---

## Prerequisites

You should have already completed:
- [x] STEP 1: Created Google Service Account
- [x] STEP 2: Shared your Google Sheet with the service account
- [x] STEP 3: Configured credentials in Supabase (Option B) or your browser (Option A)

If using **Option B (Server-Side)**, you also need to set up GitHub Secrets (one-time setup).

---

## One-Time Setup: Add GitHub Secrets

**Do this once, then you can activate anytime by running the workflow.**

### Gather Information from Supabase

1. **Access Token:**
   - Go to https://supabase.com/dashboard/account/tokens
   - Click "Generate new token"
   - Copy the token (starts with `sbp_`)

2. **Project Reference:**
   - Go to https://supabase.com/dashboard
   - Select your project
   - Click Settings → General
   - Copy the **Reference ID** (e.g., `abcdefghijklmnop`)

3. **Database Password:**
   - Your password from when you created the Supabase project
   - Or reset it: Settings → Database → Reset password

### Add Secrets to GitHub

1. Go to your GitHub repository
2. Click **Settings** (top navigation)
3. Click **Secrets and variables** → **Actions** (left sidebar)
4. Click **New repository secret** and add:
   - Name: `SUPABASE_ACCESS_TOKEN` | Value: (your token from above)
   - Name: `SUPABASE_PROJECT_REF` | Value: (your project ID)
   - Name: `SUPABASE_DB_PASSWORD` | Value: (your database password)

✓ **Done with setup!**

---

## Activate the Connection (Anytime)

### Click-Only Steps

1. **Open GitHub**
   - Go to https://github.com/bravobraverman1/lighting-style-product-creation
   - Click the **Actions** tab

2. **Select the Workflow**
   - In the left sidebar, click **"Deploy Google Sheets Connection"**

3. **Run the Workflow**
   - Click **"Run workflow"** button on the right
   - Select **production** (or staging)
   - Click **"Run workflow"** to confirm

4. **Wait for Completion**
   - Watch the workflow run
   - Look for a green checkmark ✓
   - Takes 2-3 minutes

---

## Verify It Works

After the workflow completes (green checkmark):

1. Open your Product Entry Hub application
2. Go to **Admin** page
3. Scroll to **Google Sheets Connection**
4. Click **"Test Connection"**
5. You should see: ✓ Connection successful!

If you see actual SKU data (not mock data), you're all set! 🎉

---

## Troubleshooting

### Workflow Shows Red ❌

**Check your GitHub Secrets:**
- Settings → Secrets and variables → Actions
- Verify all three secrets are present and correct:
  - `SUPABASE_ACCESS_TOKEN` (starts with `sbp_`)
  - `SUPABASE_PROJECT_REF` (your project ID)
  - `SUPABASE_DB_PASSWORD` (your database password)

**If incorrect, update them and run the workflow again.**

### Test Connection Fails

**Clear your browser cache:**
- Press Ctrl+Shift+Delete (Windows) or Cmd+Shift+Delete (Mac)
- Reload the Admin page
- Click "Test Connection" again

**If still failing:**
- Verify service account email has Editor access to your Google Sheet
- Check Supabase Dashboard → Edge Functions → Logs for errors

---

## Common Questions

**Q: Do I need to run this workflow every time I use the app?**  
A: No! Run it once, then your connection stays active.

**Q: Is my data safe?**  
A: Yes! GitHub Secrets are encrypted. No credentials are exposed in logs.

**Q: What if something goes wrong?**  
A: Just run the workflow again. It's completely safe to repeat.

**Q: Do I need Supabase CLI installed?**  
A: No! GitHub Actions handles everything for you.

**Q: Can I use my browser-based credentials instead?**  
A: Yes! If you used Option A (browser-based config in STEP 3), you don't need this workflow. Skip it entirely.

---

## Next Steps

✓ Activation complete!

1. Load a product from SKU Selector
2. Fill out the form
3. Submit it
4. Check your OUTPUT sheet to verify it was written

**Need help?** See [GOOGLE_SHEETS_SETUP.md](./GOOGLE_SHEETS_SETUP.md) or [GITHUB_ACTIONS_SETUP.md](./GITHUB_ACTIONS_SETUP.md)
