# STRIDE Mobile (Flutter)

Cross-platform mobile app for the STRIDE running training project. **Android v1** is the current target; iOS Phase 2 reuses the same `lib/` codebase.

This is a client of the existing FastAPI backend at `https://stride-app.<region>.azurecontainerapps.io/api/*` (auth via `https://auth-backend.<region>.azurecontainerapps.io/api/auth/*`). No new backend endpoints required for v1 reads — push notifications (S13a) add a few.

## Quick reference

- **Plan:** `../.omc/plans/stride-mobile-app-android-v1.md`
- **Design system:** `mobile/DESIGN.md` (verbatim Vercel) + `mobile/STRIDE_OVERRIDES.md` (accent-green + extended Mono)
- **Package name / bundle id:** `cn.striderunning.app`
- **Min SDK:** API 26 (Android 8.0)
- **Domain:** `stride-running.cn`

## Setup

Requires Flutter SDK (stable channel ≥ 3.40) and Android SDK (cmdline-tools or full Android Studio).

```bash
# 1. Resolve dependencies
cd mobile
flutter pub get

# 2. Generate codegen output (Drift, Retrofit, json_serializable, Riverpod)
dart run build_runner build --delete-conflicting-outputs

# 3. (One-time) Generate launcher icons from assets/branding/icon-1024.png
dart run flutter_launcher_icons

# 4. Run on connected device or emulator
flutter run
```

## Project layout

```
lib/
├── main.dart                # entry point + ProviderScope
├── app.dart                 # MaterialApp + (later) GoRouter
├── core/                    # Cross-cutting concerns
│   ├── api/                 # Dio client + interceptors
│   ├── auth/                # auth-service tokens + secure storage
│   ├── theme/               # Material theme from DESIGN.md tokens
│   ├── router/              # GoRouter routes + auth guards
│   ├── env/                 # API base URL, build flavors
│   └── notifications/       # JPush integration + permission UX
├── data/
│   ├── models/              # @JsonSerializable mirrors of stride_core
│   ├── api/                 # @RestApi() Retrofit-Dart services
│   ├── db/                  # Drift schema + tables (offline cache)
│   └── repos/               # Cache + network composition
├── features/                # One folder per screen/feature
│   ├── login/, today/, activity/, health/
│   ├── teams/, plan/, profile/
└── shared/
    ├── widgets/             # HRChart, PaceChart, primitives
    └── utils/               # date / pace formatting (mirrors api.ts)
```

## Hand-written API client (no codegen)

Per plan §11 O3, all API client code is hand-written `@RestApi()` + `@JsonSerializable()`. When backend models change in `src/stride_core/`, update `mobile/lib/data/models/` in the same PR. No OpenAPI generator, no schema drift detection beyond this discipline.

## Push notifications (JPush)

- **Provider:** 极光推送 (JPush) — covers MiPush / HMS Push / Honor Push / FCM fallback
- **Not covered (v1):** OPPO + vivo (require 营业执照 / 软著, deferred to v1.1 after individual entrepreneur registration)
- **Client AppKey:** `mobile/android/app/jpush.properties` (gitignored, copy from `.example`)
- **Server Master Secret:** Azure Key Vault `stride-kv-common/jpush-master-secret`

## Distribution (v1)

Signed APK attached to GitHub Release on tagged push (`mobile-v2026.5.0` style). No Play Store account in v1. Sideload only.

## Decisions reference

The plan file (`.omc/plans/stride-mobile-app-android-v1.md`) is the source of truth for v1 scope, tech stack rationale, acceptance criteria, and risk register. When adding a feature, check there first.
