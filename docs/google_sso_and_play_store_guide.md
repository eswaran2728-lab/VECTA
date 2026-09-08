# AirAsia VECTA & CaterLink: Google SSO & Google Play Store Setup Guide

This guide details how to configure **Google OAuth & Future AirAsia SSO**, manage **Role Segregation** (AVSEC in VECTA vs Drivers in CaterLink), and publish the mobile apps to the **Google Play Console**.

---

## 1. Google OAuth & Future AirAsia SSO

### Step 1: Google Cloud Console Setup
1. Go to the [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Click **Create Credentials** ➔ **OAuth client ID**.
3. Choose **Web application**.
4. Under **Authorized redirect URIs**, add:
   ```text
   https://zsxneokqulktgnccxgkz.supabase.co/auth/v1/callback
   http://localhost:3000/auth/callback
   ```
5. Copy the generated **Client ID** and **Client Secret**.

### Step 2: Enable Google Provider in Supabase
1. Open your Supabase Project Dashboard (`zsxneokqulktgnccxgkz`).
2. Navigate to **Authentication** ➔ **Providers** ➔ **Google**.
3. Toggle **Enable Google provider** to `ON`.
4. Paste the **Client ID** and **Client Secret**.
5. Save changes.

---

## 2. Transitioning to AirAsia Corporate SSO (`@airasia.com`)

When AirAsia ICT approves the domain integration:
1. **Option A: Google Workspace Domain Enforcement (Zero-Code Change)**:
   In Supabase Auth settings or Google Cloud OAuth Consent Screen, restrict the internal audience to `airasia.com`.
2. **Option B: SAML 2.0 / Azure AD SSO**:
   Supabase Enterprise SSO supports SAML 2.0. We simply add the AirAsia SAML metadata endpoint to Supabase Auth without changing the database schema or user table keys.

---

## 3. Role-Based Access Segregation Matrix

| User Role | System Allowed | Access Boundary Rule |
| :--- | :--- | :--- |
| **`admin`** | **VECTA** | Full operational, audit, and user management in VECTA. |
| **`management`** | **VECTA** | Operational reports, approvals, analytics. |
| **`enforcement`** | **VECTA** | Security compliance, enforcement logs, audits. |
| **`so` / `aso` / `dse`** | **VECTA** | Station & post check-in, passenger/cargo security logs. |
| **`vendor` / `ifc_driver`** | **CATERLINK** | Form A dispatch, catering transfers, driver receipts. *Blocked from VECTA.* |

---

## 4. Google Play Console & Android App Publishing

### Step 1: Android Build Toolchain
The app is pre-configured with Capacitor (`capacitor.config.json`) with package identifier `com.airasia.vecta`.

To generate Android native assets:
```bash
# Initialize Android platform wrapper
npx @capacitor/cli add android

# Build production web bundle and sync to Android project
npm run build
npx @capacitor/cli sync android

# Open Android Studio to build .aab (Android App Bundle) or .apk
npx @capacitor/cli open android
```

### Step 2: Google Play Console Submission
1. Log in to [Google Play Console](https://play.google.com/console).
2. Create an App named **"AirAsia VECTA Ops"** (or **"AirAsia CaterLink"**).
3. Set category to **Business / Productivity**.
4. In **Production** or **Internal Testing Track**, upload the generated `.aab` bundle.
5. AirAsia Private Distribution: If using Google Workspace Private Play Store, select **Advanced Settings > Managed Google Play** and restrict distribution to the AirAsia organization domain.