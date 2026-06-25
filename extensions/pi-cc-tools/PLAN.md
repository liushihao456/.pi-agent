# pi-cc-tools Refactor and Performance Plan

## Context

`/home/atomus/.pi/agent/extensions/pi-cc-tools/index.ts` has grown to roughly 6,900 lines and now mixes extension registration, message patching, markdown rendering, tool rendering, diff parsing/rendering, async diff scheduling, and cache/state management. Recent performance work improved large tool output and diff scheduling, but further changes are becoming risky because the diff/render state machine is spread across the same large file.

The goal is to simplify the plugin structure while preserving behavior, then make targeted diff-render performance improvements easier and safer.

Current observations:
- Primary code file: `index.ts` (~5,363 lines after extraction).
- Secondary extension file: `spinner.ts`.
- Typecheck entrypoint currently targets `index.ts` and `spinner.ts`.
- Latest diff scheduling work introduced `AsyncDiffService`, large streaming diff deferral, and pair-size gating for word diff.
- Remaining unrelated working-tree change exists outside this package: `/home/atomus/.pi/agent/settings.json`; do not include it in refactor commits unless explicitly requested.

## Approach

Use a conservative, behavior-preserving refactor in small phases. First split coherent modules out of `index.ts` without changing logic. New extracted `.ts` modules should live directly under the package root (`/home/atomus/.pi/agent/extensions/pi-cc-tools/`) in root-level folders such as `diff/`, `render/`, and `tools/`, not under `extensions/`. After the code is modular, introduce a shared preview-render scheduler and then apply small diff-render performance improvements.

Recommended approach:
1. Split diff-related code first because it is the current performance hotspot and has clear boundaries.
2. Split generic render utilities next (`ansi`, branch layout, preview text helpers).
3. Split write/edit tool renderers only after diff utilities are stable.
4. Add a shared async preview scheduler to replace repeated pending/display-key Promise patterns.
5. Apply targeted performance changes behind the refactored abstractions.

Avoid a full rewrite. Keep each commit small enough to typecheck and manually review.

## Files to modify

Likely new files:
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/diff/types.ts`
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/diff/parse.ts`
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/diff/render.ts`
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/diff/async-service.ts`
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/diff/summary.ts`
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/render/ansi.ts`
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/render/branch.ts`
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/render/preview.ts`
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/render/scheduler.ts`
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/tools/write.ts` later phase
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/tools/edit.ts` later phase

Existing files:
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/index.ts` — reduce to registration/orchestration plus imports.
- `/home/atomus/.pi/agent/extensions/pi-cc-tools/package.json` — update `files` and `typecheck` script to include new extension modules, if needed.

## Reuse

Existing code to preserve and relocate rather than rewrite:
- Diff parsing and cached parse helpers from `index.ts`:
  - `parseDiff`
  - `getCachedParsedDiff`
  - `offsetParsedDiff`
  - `getFirstChangedNewLine`
- Diff rendering from `index.ts`:
  - `renderUnified`
  - `renderSplit`
  - `shouldUseSplit`
  - `wordDiffAnalysis`
  - `plainWordDiff`
  - `wrapAnsi`
  - `injectBg`
  - `hlBlock`
- Diff scheduling from `index.ts`:
  - `AsyncDiffService`
  - `computeLocalizedEditDiffs`
  - `shouldDeferLargeEditDiff`
  - `shouldDeferLargeWriteDiff`
- Preview helpers already added:
  - `buildPreviewTextMapped`
  - `previewTruncationSuffix`
- Existing verification command:
  - `npm run typecheck`

## Steps

### Phase 1 — Diff module extraction, no behavior change

- [ ] Create `diff/types.ts` for `DiffLine`, `ParsedDiff`, `LocalizedEditDiff`, `WriteDiffData`, `EditDiffData`, and related types.
- [ ] Move pure diff parsing/summarizing helpers into `diff/parse.ts` and `diff/summary.ts`.
- [ ] Move `AsyncDiffService` and localized edit diff computation into `diff/async-service.ts`.
- [ ] Move diff rendering helpers into `diff/render.ts` while keeping function signatures initially unchanged.
- [ ] Update `index.ts` imports (for example, `./diff/...`) and ensure behavior is unchanged.
- [ ] Update `package.json` `files` and typecheck coverage if new `.ts` files are not automatically included by the current command.
- [ ] Run `npm run typecheck`.

### Phase 2 — Generic render utility extraction

- [ ] Move ANSI/string-width helpers into `render/ansi.ts`.
- [ ] Move branch/block formatting helpers into `render/branch.ts`.
- [ ] Move preview truncation/text-building helpers into `render/preview.ts`.
- [ ] Keep public function names stable during extraction to reduce diff noise.
- [ ] Run `npm run typecheck`.

### Phase 3 — Shared preview render scheduler

- [ ] Introduce `render/scheduler.ts` with a helper for keyed async preview rendering.
- [ ] Replace repeated patterns like `_writePreviewPendingKey`, `_writePreviewDisplayKey`, `_ptPendingKey`, `_wdk`, and `_nfk` incrementally.
- [ ] Ensure stale render completion cannot overwrite newer display state.
- [ ] Ensure stale cleanup logic cannot delete newer pending state.
- [ ] Treat cancellation/staleness as a silent no-op, not as a fallback/error display.
- [ ] Run `npm run typecheck` after each tool migration.

### Phase 4 — Tool renderer extraction

- [ ] Extract write tool registration/rendering into `tools/write.ts`.
- [ ] Extract edit tool registration/rendering into `tools/edit.ts`.
- [ ] Consider extracting bash/grep/OpenAI/MCP renderers after write/edit are stable.
- [ ] Keep `index.ts` responsible for high-level registration, patching, config, and wiring only.
- [ ] Run `npm run typecheck`.

### Phase 5 — Targeted performance improvements

- [ ] Add aggregate word-diff gating, not just per-pair gating, e.g. disable word diff when visible diff rows or total changed chars exceed a threshold.
- [ ] Add large-diff split fallback to unified rendering when added+removed rows exceed a safe threshold.
- [ ] Add render-stage latest-token/yield support through the shared scheduler.
- [ ] Add fast path in `wrapAnsi` for ASCII/no-wrap lines.
- [ ] Optionally add lightweight timing logs behind a debug flag to compare `parseDiff`, `renderSplit`, `wordDiffAnalysis`, `wrapAnsi`, and Shiki time.

## Verification

For each phase:
- [ ] Run `npm run typecheck` in `/home/atomus/.pi/agent/extensions/pi-cc-tools`.
- [ ] Check `git diff --stat` to ensure the phase is scoped.
- [ ] Confirm no unrelated `/home/atomus/.pi/agent/settings.json` changes are staged.

Manual verification after Phase 3 or later:
- [ ] Restart/reload Pi so the extension is reloaded.
- [ ] Test write preview for a new file.
- [ ] Test write preview for a modified existing file.
- [ ] Test edit preview for a single edit.
- [ ] Test edit preview for multi-edit.
- [ ] Test Ctrl-O expanded diff rendering for >100-line diffs.
- [ ] Test streaming tool-call args to confirm old diff previews do not cause visible lag or stale display.
- [ ] Test non-diff tools still render normally: bash, grep, MCP/OpenAI generic result.

## Commit strategy

- Commit Phase 1 separately: `Refactor diff utilities into modules`.
- Commit Phase 2 separately: `Extract shared render utilities`.
- Commit Phase 3 separately: `Centralize async preview scheduling`.
- Commit Phase 4 in one or more tool-specific commits.
- Commit Phase 5 as separate performance commits, each with before/after notes when possible.

Do not include unrelated `settings.json` changes in these commits.
