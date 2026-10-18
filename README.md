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
- **Tabs:** click to show in the focused pane, double-click to rename, ✕ to close, ＋ to create a blank
  workspace or copy one.

## Files

- `index.html`, `style.css`: page and styles (sidebar becomes a bottom sheet on phones)
- `main.js`: app (tabs, panes, sync, proposals, history, measurements, saving)
- `scene.js`: `RoomView`, one 3D/top view built from API data (walls, openings, furniture builders)
- `api.js`: API client; `catalog.js`: furniture presets for "Add furniture"
- `server/`: Hono app on Railway
  - `app.ts` routes, `index.ts` startup, `auth.ts` passkeys / sessions / agent keys
  - `entities.ts` what a change may touch (field registry), `changes.ts` the change engine, revisions, rollback
  - `workspaces.ts` views and copies, `proposals.ts` proposals, `measurements.ts` measurements and pins
  - `mcp.ts` MCP server at `/mcp`; `house.ts`, `export.ts`, `seed.ts`, `bootstrap.ts`
  - `uploads.ts` phone pairing codes and presigned uploads, `scans.ts` RoomPlan parser, scan review and promote to Current
- `ios/`: parent app + "Scan Room" App Clip (RoomPlan); build on a Mac, see `ios/README.md` and `SCAN_SETUP.md`
- `fixtures/`: RoomPlan `CapturedRoom` sample + generator used by the tests
- `prisma/`: fully relational MySQL schema and migrations
- `scripts/`: `predeploy.ts` (runs on every start: table snapshot to the bucket, then `prisma migrate deploy`),
  `seed.ts`, `create-setup-code.ts`, `create-agent-key.ts`
- `tests/`: `npm test` (runs only against `TEST_DATABASE_URL`: a new, empty MySQL database whose name contains "test")

## API (session cookie, or `Authorization: Bearer <agent key>` for reads and proposals)

`GET /health` · `GET /api/house` · `GET /api/workspaces[/:id]` · `GET /api/workspaces/:id/history` ·
`GET /api/rooms/:id` · `GET /api/proposals[?status=]` · `GET /api/proposals/:id[/preview]` · `POST /api/proposals` (propose scope) ·
Michael only: `POST /api/workspaces`, `/api/workspaces/:id/changes`, `/api/workspaces/:id/rollback`,
`/api/proposals/:id/approve|reject`, `/api/measurements`, `/api/measurements/unpin`,
`/api/upload-tokens` (pair phone), `/api/scans/:id/promote|reject`, `/api/current/rollback`.
Read: `GET /api/scans[/:id]`, `GET /api/current/history`. Pairing code only (App Clip): `/api/upload-tokens/validate`,
`/api/uploads/presigned`, `/api/uploads/:id/complete`, `/api/scans/import`. Current changes only through promoted scans,
measurements and rollbacks.
MCP: `POST /mcp` (see PLAN.md section 10).

House data is never committed here. The seed comes from the private `tmbradley/house-data` repo.

Local dev: `npm install`, set `DATABASE_URL` to a MySQL database, then `npm run dev` (port 3000).
