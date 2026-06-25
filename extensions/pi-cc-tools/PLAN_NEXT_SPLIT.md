# pi-cc-tools Further Split Plan

> Review note: user feedback was “基本没问题” (basically no issues), so the plan remains substantively unchanged.

## Context

After the first refactor, `index.ts` is still about 5,363 lines. It is smaller than the original ~6,897-line file by about 1,534 lines (~22%), but it still contains several large responsibilities:

- extension startup and command registration
- settings and theme/chrome state
- message/container monkey patches
- markdown/math rendering
- tool grouping UI
- built-in tool renderers beyond write/edit
- apply_patch parsing/rendering
- OpenAI/MCP/generic tool overrides

The next goal is not to make a fake 1-line `index.ts`, but to move coherent behavior into real modules so `index.ts` becomes mostly orchestration and wiring.

## Approach

Continue with conservative behavior-preserving extraction. Prioritize low-risk, high-volume tool renderers before touching tightly coupled patch/theme/markdown logic.

Recommended order:

1. Extract remaining built-in tool renderers (`read`, `bash`, `grep/find/ls`).
2. Extract `apply_patch`, which is large and relatively self-contained.
3. Extract generic/OpenAI/MCP tool override rendering.
4. Extract settings/limits helpers.
5. Reassess before splitting high-risk areas: patches, markdown/math, theme/chrome, thinking, tool groups.

Each phase should typecheck independently.

## Files to modify

Likely new files:

- `tools/read.ts`
- `tools/bash.ts`
- `tools/search.ts`
- `tools/apply-patch.ts`
- `tools/generic.ts`
- `tools/openai.ts`
- `tools/mcp.ts`
- `settings/config.ts`
- `settings/limits.ts`

Existing files:

- `index.ts` — reduce to orchestration, registration, and shared wiring.
- `package.json` — ensure new root-level modules are included by `files` and typecheck continues to cover imported files.

## Reuse

Existing code to move rather than rewrite:

- Read rendering from `index.ts`:
  - `createReadTool` registration block
  - read preview/highlight/image expansion related helpers that are only read-specific
- Bash rendering from `index.ts`:
  - `createBashTool` registration block
  - running/live output preview helpers where bash-specific
- Search/list rendering from `index.ts`:
  - `createGrepTool`, `createFindTool`, `createLsTool` registration blocks
  - tree/list result formatting specific to those tools
- Apply patch rendering from `index.ts`:
  - patch file extraction
  - apply_patch preview/result metadata types
  - patch diff parsing helpers
  - `renderApplyPatchCall`
  - `renderApplyPatchResult`
- Generic/OpenAI/MCP rendering from `index.ts`:
  - generic call/result rendering
  - `registerOpenAiToolOverrides`
  - `registerMcpToolOverrides`
  - OpenAI apply_patch special case wiring
  - MCP summary/preview rendering
- Settings/limits from `index.ts`:
  - `SettingsFile`
  - `readSettings`
  - `writeSettingsKey`
  - preview/bash/live/diff limit helpers
  - spinner bust helper

## Steps

### Phase 1 — Extract remaining built-in tools

- [ ] Create `tools/read.ts` and move read tool registration/rendering into `registerReadTool(deps)`.
- [ ] Keep image/highlight helpers in `index.ts` initially if they are shared or patch-coupled; only move read-only helpers.
- [ ] Create `tools/bash.ts` and move bash tool registration/rendering into `registerBashTool(deps)`.
- [ ] Create `tools/search.ts` and move grep/find/ls registration/rendering into `registerSearchTools(deps)`.
- [ ] Replace the old inline registration blocks in `index.ts` with calls to the new register functions.
- [ ] Run `npm run typecheck`.
- [ ] Manually smoke test read, bash, grep, find, and ls rendering.

### Phase 2 — Extract apply_patch

- [ ] Create `tools/apply-patch.ts`.
- [ ] Move apply_patch-specific interfaces and helpers into that file.
- [ ] Move `renderApplyPatchCall` and `renderApplyPatchResult` into that file.
- [ ] Keep shared diff/render helpers imported from `diff/` and `render/` modules.
- [ ] Keep OpenAI special-case wiring compatible by exporting the render functions needed by `tools/openai.ts` later.
- [ ] Run `npm run typecheck`.
- [ ] Manually test add/update/delete/multi-file apply_patch previews and failed patch results.

### Phase 3 — Extract generic/OpenAI/MCP tool overrides

- [ ] Create `tools/generic.ts` for generic tool call/result rendering helpers.
- [ ] Create `tools/openai.ts` for OpenAI tool candidate detection and override registration.
- [ ] Create `tools/mcp.ts` for MCP tool candidate detection and override registration.
- [ ] Keep `index.ts` session hooks, but have them call imported `registerOpenAiToolOverrides(...)` and `registerMcpToolOverrides(...)`.
- [ ] Run `npm run typecheck`.
- [ ] Manually test generic custom tools, OpenAI apply_patch special case, and MCP result preview/summary.

### Phase 4 — Extract settings and limits

- [ ] Create `settings/config.ts` for settings file IO, cache, and `writeSettingsKey`.
- [ ] Create `settings/limits.ts` for preview/diff/bash/live limit helpers.
- [ ] Preserve spinner settings bust behavior exactly.
- [ ] Decide whether tool background mode stays in `index.ts` or moves into settings/chrome based on dependency direction.
- [ ] Run `npm run typecheck`.
- [ ] Manually test `/cc-tools` commands that read/write settings.

### Phase 5 — Reassess high-risk areas

- [ ] Recount `index.ts` lines after Phases 1–4.
- [ ] If still too large, plan a separate extraction for one high-risk area at a time:
  - `markdown/` for markdown/math/code-block rendering
  - `patches/` for container/message/tool monkey patches
  - `tool-groups/` for grouped tool UI
  - `thinking/` for hidden thinking/worked duration logic
  - `theme/` for palette/chrome derivation

## Verification

For every phase:

- [ ] Run `npm run typecheck` in `/home/atomus/.pi/agent/extensions/pi-cc-tools`.
- [ ] Check `git diff --stat -- .` to confirm the phase is scoped to this package.
- [ ] Confirm unrelated `/home/atomus/.pi/agent/settings.json` remains untouched by this work.

Manual checks after Phase 1:

- [ ] Read text file collapsed and expanded.
- [ ] Read image file collapsed and expanded.
- [ ] Bash partial/live output and final output.
- [ ] Grep hidden/count/preview modes if configured.
- [ ] Find result rendering.
- [ ] Ls tree/list rendering.

Manual checks after Phase 2:

- [ ] apply_patch add file.
- [ ] apply_patch update file.
- [ ] apply_patch delete file.
- [ ] apply_patch multiple files.
- [ ] apply_patch failure result.

Manual checks after Phase 3:

- [ ] OpenAI apply_patch still uses rich renderer.
- [ ] Generic OpenAI tool renders call/result normally.
- [ ] MCP result hidden/summary/preview modes still work.

Manual checks after Phase 4:

- [ ] `/cc-tools status`.
- [ ] `/cc-tools group toggle`.
- [ ] `/cc-tools branch ...`.
- [ ] Preview limit settings still affect tool output.

## Expected outcome

Approximate line-count reduction:

- Phase 1: 700–1,000 lines
- Phase 2: 600–900 lines
- Phase 3: 600–900 lines
- Phase 4: 150–300 lines

Expected `index.ts` after Phases 1–4: roughly 2,500–3,500 lines, with most remaining size coming from patch/markdown/theme/thinking/tool-group logic.

## Commit strategy

- Commit Phase 1 as `Extract built-in tool renderers`.
- Commit Phase 2 as `Extract apply patch renderer`.
- Commit Phase 3 as `Extract external tool override renderers`.
- Commit Phase 4 as `Extract settings helpers`.

Do not include unrelated `settings.json` changes in these commits.
