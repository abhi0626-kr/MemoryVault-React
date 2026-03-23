# MemoryVault React Migration

This folder contains the new React + Vite version of MemoryVault.

## Implemented now (Phase 1)

- Firebase user authentication (Google + Email/Password)
- Step-based flow: user auth first, then Group ID/password unlock
- Firestore group-password validation with legacy group-id candidate support
- Basic post-login dashboard shell

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Config

- Runtime Firebase config is loaded from `public/config.public.js`
- Optional env vars are supported through `VITE_FIREBASE_*`

## Next migration phases

- Move gallery/upload components into React modules
- Port admin panel (Cloudinary + group management)
- Add face-suggestion pipeline (option A: Firebase + face-api.js)
