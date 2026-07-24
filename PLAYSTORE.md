# Publishing AcadTrack Faci to the Google Play Store

The faci panel is a PWA, so it goes to Play as a **TWA** (Trusted Web Activity) —
a thin Android wrapper around this website. No native rewrite needed.

## What's already done in this repo
- ✅ `manifest.json` (name, `standalone` display, theme color, icons, `id`)
- ✅ Service worker (`mjr-sw.js`), HTTPS (Vercel)
- ✅ `.well-known/assetlinks.json` is served (Vercel is configured to return it as
  `application/json`). **You only need to fill in two values** — see step 3.

## What YOU do (needs your Google account + machine — I can't do these for you)

### 1. Google Play Developer account
Sign up at https://play.google.com/console — **one-time US $25**. Verification
(ID + address) can take a day or two, so start this early.

### 2. Build the Android package with PWABuilder (easiest, no local Android setup)
1. Go to https://www.pwabuilder.com
2. Enter your production URL (e.g. `https://<your-faci-domain>`).
3. **Package For Stores → Android → Download.** Keep all the files it gives you:
   - `app-release-bundle.aab`  → this is what you upload to Play.
   - `signing.keystore` + the passwords it shows → **back these up safely.**
     If you lose the key you can NEVER push an update to the same listing.
   - `assetlinks.json` → it contains your real fingerprint (next step).
   *(Tip: in PWABuilder you can also upload a crisp 512×512 logo so the icon and
   splash look sharp.)*

### 3. Fill in `.well-known/assetlinks.json` and redeploy
Open the `assetlinks.json` PWABuilder generated and copy its
`package_name` and `sha256_cert_fingerprints` into this repo's
`/.well-known/assetlinks.json` (replace the two `REPLACE_WITH_...` placeholders),
commit, and let Vercel deploy. Verify it loads:
`https://<your-faci-domain>/.well-known/assetlinks.json`
This is what removes the browser address bar so the app looks native. (Send the
two values to me and I'll paste them in for you if you'd rather.)

### 4. Upload to Play Console
Create app → upload the `.aab` → fill the store listing:
- App name, short/long description
- Screenshots (phone), a 512×512 icon, a 1024×500 feature graphic
- **Privacy policy URL** → you already have `privacy.html`
- Content rating questionnaire, data-safety form, target audience
Then submit for review (first review is usually a few days).

## Notes
- Want it just as a **sideload APK** (no Play Store)? PWABuilder also gives a
  signed `.apk` — install it directly with "unknown sources" on. Free, no Google
  account. Good for testing before you publish.
- **iOS** can't be done the same way (Apple restricts PWA wrappers); this is
  Android-only, which is what you asked for.
