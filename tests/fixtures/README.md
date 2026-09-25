# Test fixtures: policy

This repository is public. Everything in `tests/fixtures/` is **hand-written and synthetic**.

- Nothing here is copied or derived from `data/`, `secrets/`, `.env*`, `mockups/d-rooftop.html`, a real bill, a real
  Tesla response, a real ScreenLogic or Nest reading, or a database dump.
- No names, street addresses, ZIP codes, coordinates, account numbers, tokens, site ids or serial numbers. The meter
  number is `12345678`, device ids are `dev-test`, site ids are short labels like `s` or `site-auto`.
- The PEC bill uses PEC's published tariff numbers only (the same fallback `server/src/app.ts` hard-codes). No
  service-address line, no account number, no name, no real usage.
- Money in tests uses obviously round placeholders. Never the owner's system price, loan, payment or payback figures.
- Dates are in 2026 only (`tests/hygiene.test.ts` enforces this for this folder).
- No snapshots: tests assert explicit numbers, plus a key-shape check for objects the views read.

`tests/hygiene.test.ts` scans `tests/`, `mockups/` and `docs/` on every run and fails on account-number, large-dollar,
street-address and loan/price shapes.
