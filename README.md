# Product Entry Hub

A comprehensive product data entry and management system built with React, TypeScript, and Google Sheets integration.

## Project info

**URL**: https://sweet-beginnings-forge.lovable.app

**GitHub**: https://github.com/bravobraverman1/lighting-style-product-creation

## 🔗 Google Sheets Integration

This application connects to Google Sheets using a **Supabase Edge Function** (backend). Lovable only hosts the frontend UI.

### 🆕 New to Setup? Start Here!

**[📘 COMPLETE SETUP GUIDE](./COMPLETE_SETUP_GUIDE.md)** - Everything you need from zero to working application (45-60 minutes)

This guide is designed for **non-technical users** and covers:
- ✅ Setting up Supabase
- ✅ Connecting to Google Sheets
- ✅ Configuring your hosting environment (Lovable, Vercel, Netlify)
- ✅ Deploying Edge Functions
- ✅ Testing everything works
- ✅ No command line or coding required!

### Quick Start (For Experienced Users)

1. **STEP 1-2:** [Create service account and share your sheet](./GOOGLE_SHEETS_SETUP.md)
2. **STEP 3:** [Create and Deploy the Edge Function](./GOOGLE_SHEETS_SETUP.md#step-3-create-and-deploy-the-edge-function)
3. **STEP 4:** [Add credentials to Supabase](./GOOGLE_SHEETS_SETUP.md#step-4-add-credentials-to-supabase)
4. **STEP 5:** [Activate via GitHub Actions](./GOOGLE_SHEETS_SETUP.md#step-5-activate-the-google-sheets-connection-github-actions)
5. **STEP 7:** [Test Your Connection](./GOOGLE_SHEETS_SETUP.md#step-7-test-your-connection)

### All Documentation

- **[COMPLETE_SETUP_GUIDE.md](./COMPLETE_SETUP_GUIDE.md)** - ⭐ START HERE - Complete guide for beginners
- **[GOOGLE_SHEETS_SETUP.md](./GOOGLE_SHEETS_SETUP.md)** - Detailed technical guide
- **[SETUP_CHECKLIST.md](./SETUP_CHECKLIST.md)** - Checkbox checklist to track your progress
- **[GITHUB_ACTIONS_SETUP.md](./GITHUB_ACTIONS_SETUP.md)** - GitHub Actions configuration
- **[STEP5_QUICK_REFERENCE.md](./STEP5_QUICK_REFERENCE.md)** - Quick reference for Step 5
- **[.github/README.md](./.github/README.md)** - GitHub Actions workflows info

### What you'll need

- A Google Sheet with required tabs (PRODUCTS, Categories, BRANDS, PROPERTIES, LEGAL, OUTPUT)
- Google Cloud Project with Service Account
- Supabase project (for server-side configuration)
- GitHub repository with proper secrets configured (for GitHub Actions activation)

### Configuration

After setup, configure your connection in the **Admin** panel:
- Set sheet tab names to match your Google Sheet
- Manage categories and properties
- Configure dropdown values
- Test the connection

## How can I edit this code?

There are several ways of editing your application.

**Use Lovable**

Simply visit the [Lovable Project](https://sweet-beginnings-forge.lovable.app) and start prompting.

Changes made via Lovable will be committed automatically to this repo.

**Use your preferred IDE**

If you want to work locally using your own IDE, you can clone this repo and push changes. Pushed changes will also be reflected in Lovable.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS

## How can I deploy this project?

Simply open [Lovable](https://sweet-beginnings-forge.lovable.app) and click on Share -> Publish.

## Can I connect a custom domain to my Lovable project?

Yes, you can!

To connect a domain, navigate to Project > Settings > Domains and click Connect Domain.

Read more here: [Setting up a custom domain](https://docs.lovable.dev/features/custom-domain#custom-domain)
