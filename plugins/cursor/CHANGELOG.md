# Changelog

## 0.2.0 — 2026-08-31

### Added
- **`cursor-delegate`: manager/implementer delegation.** `/cursor:delegate` command plus the `cursor-delegate` skill. Cursor Agent makes every repository change through the companion `task` runtime (fresh write-capable jobs); the host session plans chunks, code-reviews every diff, re-runs claimed-green suites, and is the only party that commits. Triggers only on explicit delegation requests.

## 0.1.0

- Initial version of the Cursor plugin for Cursor Agent companion commands and skills.
