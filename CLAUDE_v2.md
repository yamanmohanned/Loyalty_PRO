# CLAUDE_v2.md — Supermarket Loyalty Platform: Manager Desktop App Update

> **Version:** 2.0 — Delta update on top of `CLAUDE.md` (v1)
> **Rule:** Read `CLAUDE.md` first. Then read this file. Where this file contradicts v1,
> THIS FILE WINS. Where it is silent, v1 applies without change.
>
> **Single sentence summary of this update:**
> The manager web dashboard (`apps/dashboard`) is replaced with a native desktop
> application (`apps/manager-desktop`) built with Tauri 2 + Vite + React, distributed
> as a self-contained installer file that the developer sends to store owners or installs
> on their machines directly.

---

## 0. What changes and what stays the same

### Changes from v1
| Component | v1 | v2 |
|-----------|----|----|
| Manager app type | Next.js web app | **Tauri 2 desktop app** |
| Manager app name | `apps/dashboard` | **`apps/manager-desktop`** |
| Frontend build tool | Next.js | **Vite + React** |
| Distribution | Deploy to web server | **Installer (.exe/.msi) sent to owner** |
| Font loading | Google Fonts CDN | **Bundled locally inside the app** |
| Manager auth storage | Browser session | **OS-level credential store via Tauri** |
| Auto-update | Manual re-deploy | **Built-in Tauri updater** |

### Unchanged from v1
- The entire backend (`apps/api` — Fastify + Prisma + PostgreSQL). No changes.
- The mobile cashier assistant app (`apps/assistant` — Expo). No changes.
- The database schema and all data-model decisions.
- The API surface, security standards, RBAC, and idempotency rules.
- The design system tokens (colors, typography scale, spacing, RTL, motion).
- The screen inventory — every screen that existed in v1 is still built; the content does
  not change, only the delivery container changes.
- All coding standards, testing standards, and definition of done from v1 §9 and §10.

---

## 1. Why Tauri 2 (rationale for the record)

- **Already in the developer's toolchain** (used in MerchantFlow). No new language to learn.
- **Native Windows installer** out of the box: `.exe` (NSIS) and `.msi` with one command.
- **Small installer size** (~10–30 MB), not bundling Chromium like Electron (~150 MB).
  Matters for sending over WhatsApp or slow connections.
- **System WebView** (WebView2 on Windows via Microsoft Edge) renders the same React/Tailwind
  UI exactly as a browser would — zero UI code changes from what v1 specified.
- **Built-in auto-updater plugin** (`@tauri-apps/plugin-updater`) — the developer pushes
  updates to a server endpoint; the app checks and installs silently.
- **OS credential store integration** for secure token storage.
- **Capability-based security model** (Tauri 2) to lock down what the frontend can access.

---

## 2. Technology stack changes (`apps/manager-desktop`)

### 2.1 New tech in v2
- **Tauri 2** (`@tauri-apps/cli` v2, `tauri` v2 Rust crate)
- **Rust** (toolchain required — Tauri's native layer; minimal custom Rust code beyond
  boilerplate; Tauri handles the heavy lifting)
- **Vite** (replaces Next.js as the build tool for the frontend within Tauri)
- **React 18 + TypeScript** (same components as v1 spec — only the build wrapper changes)
- **Tauri plugins (install all at project init):**
  - `@tauri-apps/plugin-updater` — auto-update from a hosted manifest
  - `@tauri-apps/plugin-store` — persistent key-value store for app config
  - `@tauri-apps/plugin-opener` — open external links in the browser
  - `@tauri-apps/plugin-notification` — optional: desktop notifications for threshold events

### 2.2 What is removed / not used
- `next` — removed from this app. Next.js is not used in the desktop app (no SSR needed;
  Vite + React is the correct tool for a Tauri frontend).
- Google Fonts `<link>` tags — removed. All fonts are bundled (see §3).

### 2.3 Retained frontend dependencies
Everything else from v1 §3.3 is retained and works identically inside Tauri + Vite:
Tailwind CSS, shadcn/ui, Recharts, TanStack Query, React Hook Form + Zod, React Router v6
(replaces Next.js router), RTL configuration.

---

## 3. Critical: Font bundling (mandatory, not optional)

**This is the single most common failure point when converting web apps to Tauri desktop
apps.** A desktop app may run without internet access. Google Fonts CDN will be unavailable.
If fonts are not bundled, the app will silently fall back to a system font and render
incorrectly.

### 3.1 Required font files to bundle
Download and include in `apps/manager-desktop/src/assets/fonts/`:

| Font | Weights needed | Format |
|------|----------------|--------|
| Cairo | 400, 600, 700 | `.woff2` |
| IBM Plex Sans Arabic | 400, 500, 600 | `.woff2` |
| IBM Plex Mono | 400, 600 | `.woff2` |

Obtain from Google Fonts "Download family" or use `fontsource` npm packages:
```
pnpm add @fontsource/cairo @fontsource/ibm-plex-sans-arabic @fontsource/ibm-plex-mono
```
Import them in `src/main.tsx` at the top:
```ts
import '@fontsource/cairo/400.css';
import '@fontsource/cairo/600.css';
import '@fontsource/cairo/700.css';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
```
This ensures fonts are bundled by Vite into the app's assets — no CDN call ever happens.

### 3.2 Verify
After building the app, disconnect from the internet entirely and launch the `.exe`. Run
through every screen. If fonts render correctly → bundling is successful.

---

## 4. Monorepo structure change

```diff
  apps/
-   dashboard/        ← REMOVED (Next.js web dashboard)
+   manager-desktop/  ← NEW (Tauri 2 desktop app)
      src/            (Vite + React frontend — same screens as v1 spec)
      src-tauri/      (Tauri native shell)
        src/
          main.rs
          lib.rs
        Cargo.toml
        tauri.conf.json
        capabilities/
          default.json
        icons/        ← ALL icon sizes live here (see §5)
      index.html
      vite.config.ts
      package.json
    assistant/        (unchanged)
    api/              (unchanged)
  packages/
    shared-types/     (unchanged)
    config/           (unchanged)
```

---

## 5. App icon specification

The icon is the brand's first impression in the installer wizard and the Windows taskbar.
It must be designed to the brand and provided in every required format.

### 5.1 Brand brief for the icon
- Color: Deep Teal `#0F6E56` as the primary fill.
- Shape: a clean, modern Arabic letterform or an abstract loyalty/receipt motif. Simple
  enough to read at 16×16 pixels. No gradients. No embossed textures.
- Wordmark: the letter "و" (from "ولاء") or a custom minimal symbol — not a full Arabic
  word at small sizes.

### 5.2 Required files (must all be in `src-tauri/icons/`)

| Filename | Size | Format | Used by |
|----------|------|--------|---------|
| `32x32.png` | 32×32 | PNG | Linux tray |
| `128x128.png` | 128×128 | PNG | Linux desktop |
| `128x128@2x.png` | 256×256 | PNG | macOS Retina |
| `icon.png` | 512×512 | PNG | Source + Linux |
| `icon.ico` | Multi-size ICO | ICO | Windows (16, 32, 48, 64, 128, 256 frames) |
| `icon.icns` | Multi-size ICNS | ICNS | macOS |
| `Square30x30Logo.png` | 30×30 | PNG | Windows Store |
| `Square44x44Logo.png` | 44×44 | PNG | Windows Store |
| `Square71x71Logo.png` | 71×71 | PNG | Windows Store |
| `Square89x89Logo.png` | 89×89 | PNG | Windows Store |
| `Square107x107Logo.png` | 107×107 | PNG | Windows Store |
| `Square142x142Logo.png` | 142×142 | PNG | Windows Store |
| `Square150x150Logo.png` | 150×150 | PNG | Windows |
| `Square284x284Logo.png` | 284×284 | PNG | Windows Store |
| `Square310x310Logo.png` | 310×310 | PNG | Windows Store |
| `StoreLogo.png` | 50×50 | PNG | Windows Store |

### 5.3 Generation workflow (fastest path)
1. Design or obtain the icon as a single **1024×1024 PNG** with a transparent background.
2. Run the Tauri CLI icon generator — it produces all required files from the single source:
   ```bash
   pnpm tauri icon path/to/your-icon-1024.png
   ```
   This writes every file in §5.2 to `src-tauri/icons/` automatically.
3. If a graphic tool is not available, generate a minimal SVG icon programmatically (a
   circle in Deep Teal `#0F6E56` with a white "و" letterform) and rasterize it. Record
   the decision and note that a final brand icon should replace it before first distribution.

---

## 6. Tauri configuration (`tauri.conf.json`)

```jsonc
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "ولاء",
  "version": "1.0.0",
  "identifier": "com.wala.manager",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build"
  },
  "app": {
    "windows": [
      {
        "title": "ولاء — إدارة الولاء",
        "width": 1280,
        "height": 800,
        "minWidth": 1024,
        "minHeight": 640,
        "center": true,
        "resizable": true,
        "decorations": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src 'self' https://YOUR_API_DOMAIN; img-src 'self' data:"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.ico",
      "icons/icon.icns"
    ],
    "publisher": "ولاء للتقنية",
    "copyright": "© 2026",
    "licenseFile": "LICENSE",
    "windows": {
      "digestAlgorithm": "sha256",
      "certificateThumbprint": null,
      "timestampUrl": "",
      "wix": {},
      "nsis": {
        "languages": ["Arabic"],
        "displayLanguageSelector": false,
        "installMode": "perMachine",
        "shortcutsEnabled": true
      }
    }
  },
  "plugins": {
    "updater": {
      "active": true,
      "pubkey": "YOUR_UPDATE_PUBLIC_KEY",
      "endpoints": [
        "https://YOUR_API_DOMAIN/updates/{{target}}/{{arch}}/{{current_version}}"
      ],
      "dialog": true
    },
    "store": {
      "path": "app_config.bin"
    }
  }
}
```

Replace `YOUR_API_DOMAIN` with the actual hosted API domain (see §8).
Replace `YOUR_UPDATE_PUBLIC_KEY` with the key generated by `pnpm tauri signer generate`.

---

## 7. Installer details (Windows)

### 7.1 What the installer produces
Running `pnpm tauri build` generates, in `src-tauri/target/release/bundle/`:
- `nsis/ولاء_1.0.0_x64-setup.exe` — standalone installer (NSIS), recommended for
  distribution
- `msi/ولاء_1.0.0_x64_en-US.msi` — MSI package, for managed deployments

The NSIS installer includes:
- Welcome screen with the app name and icon.
- License agreement page (create a simple Arabic `LICENSE` file).
- Installation directory selection (default: `C:\Program Files\ولاء`).
- Start Menu shortcut: **ولاء — إدارة المتجر**.
- Optional desktop shortcut.
- Uninstaller registered in Windows Add/Remove Programs.

### 7.2 Code signing — honest assessment
Without a code-signing certificate, Windows SmartScreen will show:
> "Windows protected your PC — Microsoft Defender SmartScreen prevented an unrecognized app."

The user must click "More info → Run anyway" the first time. For a developer installing on
clients' machines directly, this is manageable — demonstrate the step once.

For professional distribution where the owner installs it themselves:
- Obtain a **Standard OV code-signing certificate** (~$50–100/year from DigiCert, Sectigo,
  etc.) to reduce SmartScreen warnings.
- For zero SmartScreen warnings, an **EV certificate** (~$300–500/year) is required.
- Record this as a near-term recommendation, not a blocker for the first build.

---

## 8. Backend deployment (required: the desktop app must reach the API)

The desktop app is a frontend — it still communicates with the `apps/api` backend via HTTPS.
The backend must be hosted on a reachable server. This section defines what's needed.

### 8.1 Server minimum specification
| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 1 GB | 2 GB |
| Disk | 20 GB SSD | 40 GB SSD |
| OS | Ubuntu 24.04 LTS | Ubuntu 24.04 LTS |
| Provider | Any VPS | Hetzner CX22 / DigitalOcean $12 plan |
| Port exposure | 443 (HTTPS), 22 (SSH) | Same + 80 for HTTPS redirect |

### 8.2 Docker Compose stack (`docker-compose.yml`)
```yaml
version: "3.9"
services:
  api:
    build: ./apps/api
    restart: unless-stopped
    env_file: .env.production
    depends_on: [db, redis]
    ports: []          # exposed only via Caddy, not directly
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes: [postgres_data:/var/lib/postgresql/data]
    env_file: .env.production
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes: [redis_data:/data]
  proxy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
volumes:
  postgres_data:
  redis_data:
  caddy_data:
  caddy_config:
```

### 8.3 Caddy config (automatic HTTPS with Let's Encrypt)
```
api.yourdomain.com {
    reverse_proxy api:3000
}
```
Point your domain's A record to the server IP. Caddy handles TLS automatically.

### 8.4 Firewall (UFW)
```bash
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP (redirect to HTTPS)
ufw allow 443/tcp  # HTTPS
ufw enable
```

### 8.5 Environment variables (`.env.production` — never in the repo)
```env
DATABASE_URL=postgresql://wala_user:STRONG_PASSWORD@db:5432/wala_db
REDIS_URL=redis://redis:6379
JWT_SECRET=GENERATE_WITH_openssl_rand_-hex_32
JWT_REFRESH_SECRET=GENERATE_WITH_openssl_rand_-hex_32
ARGON2_SECRET=GENERATE_WITH_openssl_rand_-hex_16
WHATSAPP_API_TOKEN=your_meta_cloud_api_token
WHATSAPP_PHONE_NUMBER_ID=your_number_id
NODE_ENV=production
PORT=3000
API_BASE_URL=https://api.yourdomain.com
```

### 8.6 First deployment steps
```bash
git pull
docker compose -f docker-compose.yml up -d --build
docker compose exec api pnpm prisma migrate deploy
docker compose exec api pnpm seed:prod   # seeds the first merchant + owner account
```

---

## 9. App first-run configuration model

The desktop app needs to know the API server URL. This is handled as follows:

### 9.1 Configuration storage
Tauri plugin-store saves a config file in the OS app-data directory:
- Windows: `C:\Users\<user>\AppData\Roaming\com.wala.manager\app_config.bin`
- Managed via `@tauri-apps/plugin-store` — not directly editable by the user.

Config keys:
```ts
{
  api_url: string,           // e.g. "https://api.yourdomain.com"
  merchant_id: string | null // optional; if pre-set, skip merchant selection
}
```

### 9.2 First-run flow
```
App launches
→ Check if api_url is set in the store
│
├─ NOT SET → show First-Run Setup Screen:
│     • Input: "رابط الخادم" (pre-filled with the developer's server URL)
│     • Confirm → test the API URL (GET /health) → save if reachable → proceed to Login
│
└─ SET → skip setup → show Login screen directly
```

### 9.3 First-Run Setup Screen design
A clean full-window screen (not a modal), centered, white surface card:
- Logo + "ولاء" headline, subline "الإعداد الأولي".
- A single input "رابط خادم ولاء" with a placeholder `https://api.yourdomain.com`.
- A primary Deep Teal button "اتصال والمتابعة" — tests reachability and on success saves
  and navigates to Login.
- A Signal Red inline error under the input for unreachable server.
- An info strip: "إذا لم تكن متأكداً، تواصل مع الدعم الفني".
No other fields. No branding clutter. One job: point the app to its server.

---

## 10. Auto-updater workflow

### 10.1 How it works
The Tauri updater checks an endpoint on launch (or on a schedule) for a signed update manifest.
If a newer version exists, it prompts the user and installs automatically.

### 10.2 Update manifest endpoint
Host a JSON file at `GET /updates/{target}/{arch}/{current_version}`:
```json
{
  "version": "1.1.0",
  "notes": "تحسينات في الأداء وإصلاح أخطاء",
  "pub_date": "2026-09-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "TAURI_SIGNATURE",
      "url": "https://api.yourdomain.com/releases/wala-manager_1.1.0_x64-setup.exe"
    }
  }
}
```
Return HTTP 204 if no update is available (current version is the latest).

### 10.3 Signing update packages
```bash
# Generate the signing key pair once, store the private key securely offline
pnpm tauri signer generate -w ~/.tauri/wala.key

# Sign the built installer
pnpm tauri signer sign -k ~/.tauri/wala.key path/to/installer.exe
```
The public key goes in `tauri.conf.json` → `plugins.updater.pubkey`.
The private key NEVER goes in the repo. Store it in a password manager.

### 10.4 Update UX
With `"dialog": true` in the updater config, Tauri shows a native dialog:
> "تحديث جديد متاح (1.1.0). هل تريد التثبيت الآن؟" with Install / Later buttons.
The update installs silently and restarts the app.

---

## 11. Capability configuration (Tauri 2 security model)

Create `src-tauri/capabilities/default.json`:
```json
{
  "identifier": "default",
  "description": "Default capabilities for the manager desktop app",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "store:default",
    "updater:default",
    "opener:default",
    "notification:default"
  ]
}
```

The frontend JavaScript has NO access to the filesystem, shell, or OS — only what is
explicitly listed in capabilities. The API is reached via standard `fetch()` to the HTTPS
endpoint in the CSP allowlist. This is the correct security posture.

---

## 12. Distribution workflow (step-by-step for the developer)

This is what the developer (يمان) does to set up a new store:

### 12.1 One-time server setup (done once for all stores)
1. Provision a VPS and point a domain (e.g. `api.wala-app.com`) to it.
2. Clone the repo, copy `.env.production`, run `docker compose up -d --build`.
3. Run migrations and seed the first merchant account.
4. Generate and store the Tauri signing key pair offline.
5. Set up the update endpoint (a simple route in the API or a static JSON file).

### 12.2 Per-store setup
1. Log into the manager panel (web or the desktop app) as the owner.
2. Create a new `merchant` record + a branch + the owner `user` account + the default
   loyalty rule set.
3. Build the installer: `pnpm tauri build` → get `nsis/ولاء_x.x.x_x64-setup.exe`.
   (The same installer works for all stores — it asks for the server URL on first run.)
4. Send the `.exe` to the store owner via WhatsApp/email, or go to their location and
   install it directly. Walk through the first-run setup screen with them (server URL +
   their credentials). Demo the core loop once.

### 12.3 Pushing an update
1. Increment the version in `tauri.conf.json` and `package.json`.
2. `pnpm tauri build` → sign the new installer.
3. Upload the signed installer and update the update manifest on the server.
4. All installed apps check on next launch and offer the update automatically.

---

## 13. Updated definition of done (v2 additions)

A feature is done when all v1 §10 criteria are met AND:
- The app builds with `pnpm tauri build` with no errors.
- The installer launches on a clean Windows machine and completes without errors.
- The first-run setup screen appears, accepts the server URL, and routes to Login.
- After login, every dashboard screen renders correctly with RTL and bundled Arabic fonts
  (verified offline — no internet connection).
- The auto-updater check runs and returns a no-update response (HTTP 204) without errors.
- The app icon appears correctly in the Windows taskbar, Start Menu, and Alt-Tab.

---

## 14. Anti-patterns added in v2

- Do NOT load fonts from a CDN. Fonts must be bundled. Any `<link rel="stylesheet" href="https://fonts.googleapis.com/...">` is a critical bug in a desktop app.
- Do NOT use Next.js in `apps/manager-desktop`. Vite + React is correct for Tauri.
- Do NOT hardcode the API URL in the source code. Use the plugin-store config (§9).
- Do NOT store the Tauri update signing private key in the repository.
- Do NOT use `tauri::api::shell::open` or filesystem APIs from the frontend without
  declaring the capability explicitly.
- Do NOT ship without testing on a clean Windows machine (not just the dev machine with
  all tools installed). The installer must work on a clean OS.
