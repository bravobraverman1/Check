# Security Documentation

## Overview
This application implements comprehensive security measures to protect Google Sheets data and system integrity.

## Completed Security Fixes

### 1. ✅ Credential Protection
**Issue:** Google Service Account credentials were stored in browser localStorage and sent in API requests.

**Fix:** 
- Credentials are now **server-side only** in Supabase secrets
- No credentials are stored in browser storage
- Edge function uses `Deno.env` to access secrets
- Request body credentials are explicitly rejected

**Configuration:**
- Set `GOOGLE_SERVICE_ACCOUNT_KEY` and `GOOGLE_SHEET_ID` in your Supabase project settings
- Never paste credentials into the browser

---

### 2. ✅ Input Validation
**Issue:** Edge function accepted unvalidated user inputs, enabling injection attacks.

**Fix:** All parameters now have strict validation:

| Parameter | Type | Validation |
|-----------|------|-----------|
| `action` | string | Must be `read`, `write`, `write-categories`, or `write-brands` |
| `tabNames` | object | String values only, 0-255 chars each |
| `rowData` | array | Array of strings, each <10KB |
| `categoryPaths` | array | Array of strings, 1-1000 chars each |
| `brands` | array | Objects with brand (1-255), brandName (<255), website (<2000) |

**Implementation:** Type checking and length limits prevent buffer overflows and injection attacks.

---

### 3. ✅ Authentication
**Issue:** Edge function had no authentication, allowing anyone with the URL to access Google Sheets.

**Fix:**
- All requests require `Authorization: Bearer <token>` header
- Token must be valid Supabase JWT
- Automatically enforced by `supabase.functions.invoke()`
- Invalid tokens receive `401 Unauthorized` response

**Verification:** Browser dev tools show Authorization header is included automatically by Supabase client.

---

### 4. ✅ CORS Security
**Issue:** Wildcard CORS (`*`) allowed requests from any origin, combined with no auth enabled unauthorized cross-origin access.

**Fix:**
- CORS restricted to known origins only
- Default allowed origins: `http://localhost:5173`, `http://localhost:3000`
- Production origin configurable via `ALLOWED_ORIGIN` environment variable
- Dynamic origin validation per request

**Configuration:**
```bash
# In Supabase Edge Function environment:
ALLOWED_ORIGIN=https://yourdomain.com
```

---

### 5. ⚠️ Row Level Security (RLS)
**Status:** NOT APPLICABLE - This application does not use Supabase tables.

**Why RLS is not needed:**
This application stores all data in **Google Sheets**, not in Supabase database tables. Therefore, RLS policies are not applicable.

**What this means:**
- ✅ Data security is handled by Google Sheets permissions (service account access)
- ✅ Edge function authentication protects API access
- ✅ No Supabase database tables to secure
- ✅ **You can skip RLS setup entirely**

**If you add Supabase tables in the future:**
Then you would need to enable RLS. For now, it's not needed.

---

### 6. ⚠️ Authentication & Authorization
**Status:** Application currently has no user authentication.

**Recommendation for production:**
- Implement Supabase Auth for user login
- Add role-based access control (Admin, Editor, Viewer)
- Protect Admin page with authentication check

**Current state:**
- All pages including Admin are publicly accessible
- Consider this if running in production with sensitive data

---

## Request Flow Diagram

```
Browser → (1) Auth Token (JWT)
         → (2) Input Parameters
         ↓
Edge Function
  → (3) Validate Origin (CORS check)
  → (4) Verify JWT Token
  → (5) Validate Input Parameters
  → (6) Retrieve Server Secrets (Deno.env)
  → (7) Authenticate with Google Sheets
  ↓
Google Sheets API
  ← Read/Write Data
  ↓
Browser (Secure Response)
```

## Security Checklist

### ✅ Edge Function Security
- [x] Input validation for all parameters
- [x] Authentication required (JWT)
- [x] CORS restricted to known origins
- [x] Credentials stored server-side only
- [x] Error messages don't leak sensitive info

### ⚠️ Recommended (Not yet implemented)
- [ ] Row Level Security (RLS) enabled on Supabase tables
- [ ] User authentication system (Supabase Auth)
- [ ] Admin page access control
- [ ] Rate limiting on edge function
- [ ] Audit logging for all write operations

### ✅ Deployment Security
- [x] Credentials in Supabase secrets (not code)
- [x] Build-time environment variables for public URLs
- [x] No hardcoded API keys or secrets

---

## Testing Security

### Test 1: Verify No Wildcard CORS
```bash
# Should FAIL with CORS error
curl -H "Origin: https://evil.com" \
  https://your-project.supabase.co/functions/v1/google-sheets
```

### Test 2: Verify Auth Required
```bash
# Should FAIL with 401 Unauthorized
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"action":"read"}' \
  https://your-project.supabase.co/functions/v1/google-sheets
```

### Test 3: Verify Input Validation
```bash
# Should FAIL with 400 Bad Request (invalid action)
curl -X POST \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"delete_all"}' \
  https://your-project.supabase.co/functions/v1/google-sheets
```

---

## Additional Security Recommendations

### For Production Deployments:

1. **Enable Supabase RLS**
   - Protect all tables with row-level policies
   - Ensure users can only access their own data

2. **Add User Authentication**
   - Implement Supabase Auth or your chosen auth provider
   - Require login for Admin pages

3. **Monitor Edge Function Logs**
   - Check Supabase dashboard for errors
   - Set up alerts for suspicious activity

4. **Regular Security Audits**
   - Run security scanning tools
   - Review access logs regularly
   - Keep dependencies updated

5. **Backup Strategy**
   - Regular backups of Google Sheet data
   - Test recovery procedures

---

## References

- [Supabase Security Best Practices](https://supabase.com/docs/guides/platform/security)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Google Sheets API Security](https://developers.google.com/sheets/api/guides/authorizing-requests)

---

## Support

For security concerns or questions, refer to the setup guide or create an issue in the GitHub repository.

**Last Updated:** February 10, 2026
