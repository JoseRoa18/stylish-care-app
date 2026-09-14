# WeCare — brand assets

The mark is a water drop with a heart in it: the drop for the product (kitchen
and bath), the heart for customer care.

Every file here was renamed after what it actually contains. The originals
arrived with scrambled names and extensions — a PNG called `.svg`, a 32×32
called `-1024`, `dark` on the lockup meant for light backgrounds — so the names
below are derived from decoding each file's real format, pixel size and fill
colours, not from what it was called.

## Palette

| Colour | Hex | Use |
|---|---|---|
| Black | `#0c0c0c` | drop, wordmark on light backgrounds |
| Beige | `#ccc1b6` | drop and wordmark on dark backgrounds |
| Dark red | `#8b0000` | the heart, and the solid-red drop |
| Grey | `#474747` | the tagline under the wordmark |

## What to use where

| Need | File |
|---|---|
| Favicon | `favicon.ico`, or `svg/icon-duo.svg` |
| App icon (PWA, Apple touch) | `png/appicon-*.png` — black tile, beige drop, already padded |
| Logo in the app header | `svg/icon-duo.svg` beside the existing text |
| Email signature / document header, light background | `svg/lockup-duo-light.svg` |
| Slide or page with a dark background | `svg/lockup-duo-dark.svg` |

Prefer the SVGs: they scale, and the PNGs are just exports of them.

## `svg/`

Icons are 256×256, lockups 480×160.

| File | Drop | Heart | Text | For |
|---|---|---|---|---|
| `icon-duo.svg` | black | red | — | light backgrounds |
| `icon-duo-beige.svg` | beige | red | — | dark backgrounds |
| `icon-red.svg` | red | — | — | one-colour use |
| `icon-black.svg` | black | — | — | one-colour use |
| `icon-beige.svg` | beige | — | — | one-colour use, dark background |
| `appicon.svg` | beige on a black tile | — | — | app icon, has its own background |
| `lockup-duo-light.svg` | black | red | black | light backgrounds |
| `lockup-duo-dark.svg` | beige | red | beige | dark backgrounds |
| `lockup-light.svg` | red | — | black | light backgrounds |
| `lockup-dark.svg` | red | — | beige | dark backgrounds |

The lockups carry the tagline "ATENCIÓN AL CLIENTE · STYLISH" — Spanish. The app
interface is in English, which is why the header uses the icon next to its own
text rather than a lockup.

## `png/`

Exports of the SVGs above, transparent except the `appicon-*` tiles. The number
is the real pixel size.

- `icon-duo-{64,128,256,512}.png` — black drop, red heart
- `icon-red-{32,64,128,256,512}.png` — solid red drop
- `appicon-{180,512,1024}.png` — black tile with a beige drop (180 is the Apple touch icon size)
- `lockup-{light,dark}-1200.png` and `lockup-duo-{light,dark}-1200.png` — 1200×400

## Copies the app serves

`client/public/` holds the few files the running app links to (favicon, app
icons, the header mark). They are copies of what is here — this folder stays the
source of truth.
