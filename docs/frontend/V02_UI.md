# V0.2 Hub workspace

The Hub edits Goal, Current Action, Next Action, tasks, Focus Mode and manually entered signals. AI provider connections are reserved for a later phase. Goal and action fields accept up to 64 printable ASCII characters. Existing tasks retain their 40-character limit. Empty actions use unfinished tasks in saved order. Focus Mode temporarily overrides current action and preserves the saved work state.

Signal content, source and priority are editable. UTC creation timestamps are displayed in the saved workspace timezone with an explicit timezone label. Acknowledge, Ignore and Close retain records in the Hub and remove them from the ambient selection after saving. Reopen returns a record to active selection. Closed records can be explicitly removed. Four records can be stored, including history. Signal edits update the signal records after explicit saving.

## Data and revisions

`OverviewSource.updateWorkState` writes the combined work state and signal draft to the versioned work-state endpoint. It uses the same request size validation, loopback same-origin policy and shared hook write lock as tasks and focus. The editor captures a revision on the first draft change. Polling keeps drafts intact. A changed saved revision blocks saving until an explicit discard and reload. Failed saves retain drafts and require a user retry. Task and Focus Mode request semantics are preserved.

## Device preview

`EpaperPreview` calls `contracts/display-snapshot.ts` for both saved data and live drafts. It paints the returned palette indexes into a real 400 by 300 canvas. The shared bitmap fonts and command positions are the ones consumed by the unified firmware. A screen-reader transcript comes directly from text commands.

The preview labels unsaved drafts and saved snapshots. Physical delivery requires a manual screen check. Task drafts are previewed through an optional callback from the existing task editor. Invalid unsupported draft characters render as question marks, while save validation rejects them.

## Verification

Run `npm run test:frontend` from the project root and `npm run build`. The suite retains existing task/focus, polling, failures, conflicts and HTTP safety coverage, updates assertions for the intentional bitmap preview, and adds work-state/signal/draft/canvas integration tests. Browser screenshots and physical acceptance are recorded separately by the Tech Lead.

The final frontend suite passes 54 tests. Production TypeScript/Vite build and actual-browser pixel/draft/save checks pass. See `docs/V02_DELIVERY.md` for screenshots, all module results and the complete firmware build evidence.

The Hub uses local font fallbacks and bundled display glyphs for offline operation. New workspace labels use English. Existing task/focus control translations are preserved.
