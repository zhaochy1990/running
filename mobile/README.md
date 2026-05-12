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
├── app.dart                 # MaterialApp + GoRouter (v1 legacy + v2 gated)
├── core/                    # Cross-cutting concerns
│   ├── api/                 # Dio client + interceptors
│   ├── auth/                # auth-service tokens + secure storage
│   ├── theme/               # Material theme from DESIGN.md tokens
│   │   ├── tokens.dart      # Design token constants (color, spacing, radius, font size)
│   │   ├── pill_colors.dart # Pill variant color resolution
│   │   └── app_colors.dart  # AppColors (legacy, being replaced by tokens.dart)
│   ├── router/              # GoRouter routes + auth guards
│   │   ├── app_router_v2.dart  # M1 v2 router with redirect rules
│   │   └── routes_v2.dart      # RoutesV2 path constants (/v2/*)
│   ├── env/                 # API base URL, build flavors
│   └── notifications/       # JPush integration + permission UX
├── data/
│   ├── models/              # @JsonSerializable mirrors of stride_core
│   ├── api/                 # @RestApi() Retrofit-Dart services
│   ├── db/                  # Drift schema + tables (offline cache)
│   └── repos/               # Cache + network composition
├── features/                # Legacy v1 screens (pre-M1)
│   ├── login/, today/, activity/, health/
│   ├── teams/, plan/, profile/
├── features_v2/             # M1 rewrite — gated behind STRIDE_V2=true
│   ├── _shared/             # Shared widgets + shell
│   │   ├── shell/           # MainShellV2 (bottom nav scaffold)
│   │   └── widgets/         # StridePill, StrideStatRow, StrideTopBar,
│   │                        # StrideNavTab, StrideSegControl, StridePhoneCard
│   ├── auth/                # A1 AuthStartScreen, A2 AuthLoginScreen, A3 AuthRegisterScreen
│   ├── onboarding/          # B1 BrandScreen, B2 CorosLinkScreen, B3 SyncProgressScreen,
│   │                        # B4 BasicInfoScreen, B5 BlockedScreen
│   ├── home/                # D5 HomeScreen (status rings + activity feed + plan CTA)
│   ├── activity/            # D8 ActivityDetailScreen (stats, charts, laps)
│   ├── health/              # E1 HealthOverviewScreen (2×2 metric cards + sleep chart)
│   └── profile/             # G1 ProfileScreen (user header + menu + logout)
└── shared/
    ├── widgets/             # HRChart, PaceChart, primitives
    └── utils/               # date / pace formatting (mirrors api.ts)
```

## features_v2 — M1 Rewrite

`features_v2/` contains the full M1 screen set (12 screens). All routes use the `/v2/` prefix and coexist with legacy routes.

### Enabling v2 UI

```bash
# Run with v2 router enabled
flutter run --dart-define=STRIDE_V2=true

# Build APK with v2 router enabled
flutter build apk --dart-define=STRIDE_V2=true
```

Without `STRIDE_V2=true`, the app falls back to the legacy router and v1 screens.

### v2 Router redirect rules

```
No token            → /v2/auth/start
Token, !onboardingComplete → /v2/onboarding/brand
Token, !hasWatch    → /v2/onboarding/blocked
else                → as requested (home default)
```

### v2 Route map

| Path | Screen | ID |
|------|--------|----|
| `/v2/auth/start` | AuthStartScreen | A1 |
| `/v2/auth/login` | AuthLoginScreen | A2 |
| `/v2/auth/register` | AuthRegisterScreen | A3 |
| `/v2/onboarding/brand` | BrandScreen | B1 |
| `/v2/onboarding/coros` | CorosLinkScreen | B2 |
| `/v2/onboarding/sync` | SyncProgressScreen | B3 |
| `/v2/onboarding/basic-info` | BasicInfoScreen | B4 |
| `/v2/onboarding/blocked` | BlockedScreen | B5 |
| `/v2/home` | HomeScreen (shell tab) | D5 |
| `/v2/train` | TrainPlaceholderScreen (shell tab) | — |
| `/v2/data` | HealthOverviewScreen (shell tab) | E1 |
| `/v2/me` | ProfileScreen (shell tab) | G1 |
| `/v2/activity/:id` | ActivityDetailScreen (full-screen) | D8 |

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
