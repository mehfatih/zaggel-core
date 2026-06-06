# ADR-0007 — Currency formatting rules

- **Status:** Accepted (S0); formatter + golden-file tests **implemented in S3** (`src/lib/currency/format.ts`). Arabic-Indic separators ruled: thousands `٬` (U+066C), decimal `٫` (U+066B).
- **Context:** Shopify not supporting IQD (prices baked into images) is the founding pain. We own currency display end-to-end and must render every Arab currency + TRY correctly, in Western or Arabic-Indic numerals.

## Decision
We own a **static currency catalog** (`src/data/currencies.json`, seeded into `currencies`). Each entry carries: `code`, `symbolAr`, `symbolEn`, `nameAr`, `nameEn`, `decimals`, `numeralStyle` (default), `position` (before/after).

Rules:
- **Decimals are practical, not blindly ISO:** `IQD = 0` (operator decision), `KWD/BHD/OMR/JOD/TND/LYD = 3`, most others `2`, `DJF/KMF = 0`.
- **Numerals:** support Western (`21,000`) and **Arabic-Indic** (`٢١٬٠٠٠`). `numeralStyle` is the per-currency default; a form may override at display time.
- **Thousands separator / symbol position** come from the catalog (e.g. `٢١٬٠٠٠ د.ع` — symbol after, Arabic-Indic).
- **FX is NEVER applied to displayed prices (L4).** Prices are merchant-authored (Mode B) or store-linked (Mode A). FX rates exist only for *reporting* conversion (ADR/A5), are merchant-set + dated, and never silently mutate what a customer saw.
- **Order accounting integrity (S3):** orders persist both `display_price/display_currency` (the promise) and optional `store_price/store_currency` (mapping/reporting).

## Consequences
- Display is deterministic and testable: S3 ships **golden-file tests for every currency × numeral system × position**, plus a property test `parse(format(x)) === x`.
- The catalog is product data — changes are versioned and reviewed, not config toggles.
