# House planner (family-room-3d)

A whole-house 3D design planner for Michael's house, live at
<https://app-production-1828.up.railway.app> (sign in with a passkey at `/login`).
GitHub Pages is off; the Railway app is the only editor.

- Designs live in **workspaces**, shown as tabs. The house has **no Current yet**; the working data is
  the "Test room (family room draft)" workspace. Current gets created later from a real scan or confirmed measurements.
- **Split view** shows two tabs side by side, with a **Sync** toggle for camera angle, zoom, pan and top/3D.
- Every edit is an append-only **revision**; **History** rolls back to any revision (the rollback is a new revision).
- Agents never change designs. They create **proposals** (field-level changes, rationale, source, step-by-step
  cost) that Michael approves or rejects in the **Proposals** panel, with a side-by-side preview.
- **Measurements** can be saved as measured or **pinned**; pinned values are never overwritten by scans or estimates.

Where this is headed: [PLAN.md](PLAN.md).

## Use

- **Camera:** drag to orbit, scroll/pinch to zoom, right-drag / two-finger drag to pan. *Top view* is an
  overhead orthographic plan.
- **Furniture:** tap to select, drag to move, **R** to rotate 90°, **Delete** to remove, **Esc** to deselect.
  "In this design" marks a piece existing / keep / replace / remove / new.
- **Layout:** top bar (breadcrumb, Scan room, Inbox, account), sidebar (Current rooms, designs grouped by
  room, archived designs), toolbar, canvas, and a details panel on the right (Details / Proposals / History).
  On a phone the sidebar slides in and the details panel is a bottom sheet.
- **Designs:** click the name in the breadcrumb to rename; the ⋯ menu renames, duplicates, exports or archives.
  Names are unique per room. Archived designs are read-only and can be restored; nothing is deleted.
- **Compare** shows a design next to Current, another design or a proposal, with added / changed / removed
  marks. **Save to Current…** shows what goes in and what stays an idea; confirming it is the approval.
  Approving shows an Undo toast; History rollback still works.

## API (session cookie, or `Authorization: Bearer <agent key>` for reads and proposals)

`GET /health` · `GET /api/house` · `GET /api/workspaces[/:id]` · `GET /api/workspaces/:id/history` ·
`GET /api/rooms/:id` · `GET /api/workspaces/name-check?name=` · `GET /api/proposals[?status=]` · `GET /api/proposals/:id[/preview]` · `POST /api/proposals` (propose scope) ·
Michael only: `POST /api/workspaces`, `/api/workspaces/:id/changes`, `/api/workspaces/:id/rollback`,
`/api/proposals/:id/approve|reject`, `/api/measurements`, `/api/measurements/unpin`,
`/api/upload-tokens` (pair phone; `{placementId}` for Capture this piece), `/api/scans/:id/promote|reject|furnish`,
`/api/current/rollback`, `/api/rooms/:id/fix-mirror`, `POST /api/models`, `/api/placements/:id/model`,
`/api/workspaces/:id/revert` (undo/redo), `/api/workspaces/:id/propose-as-current`, `GET|POST /api/workspaces/:id/save-to-current`,
`/api/workspaces/:id/archive`, `/api/proposals/:id/undo-approve`, `/api/measurements/:id/withdraw`.
Read: `GET /api/scans[/:id]`, `GET /api/current/history`, `GET /api/photos?roomId=|scanImportId=` (signed URLs, 10 min),
`GET /api/templates`, `GET /api/models/:id[/file]`. Pairing code only (iPhone app): `/api/upload-tokens/validate|room`,
`/api/uploads/presigned`, `/api/uploads/:id/complete`, `/api/scans/import`, `/api/models/import`, `/api/suggestions`. Current changes only through promoted scans,
measurements, approved proposals (furniture and colors only) and rollbacks.
MCP: `POST /mcp` (see PLAN.md section 10).

House data is never committed here. The seed comes from the private `tmbradley/house-data` repo.

Local dev: `npm install`, set `DATABASE_URL` to a MySQL database, then `npm run dev` (port 3000).
