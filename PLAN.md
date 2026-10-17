# House Design Planner: Project Plan

Status: draft, with Michael's decisions folded in · Last updated: Oct 17, 2026

This plan describes how the current single-room editor grows into a planner for the whole house.
Each phase lists what gets built and how we'll know it's done. Decisions made so far are marked
**Decided**. Remaining open questions are listed at the end.

**Rooms:** there's no fixed order after the family room. **Decided:** we pick the next room as we go.

---

## 1. Vision

A planner for redesigning the house one room at a time, using real dimensions.

- **Style goal:** mid-century modern, masculine, with a West Elm feel. Budget lookalikes are fine.
  The look matters more than the label.
- **What stays:** the honey oak hardwood floors. Everything else can change.
- **What it's for:** trying layouts, colors, and furniture in a true-to-scale model before buying
  anything. Comparing ideas side by side. Keeping a shopping list with real prices for each idea.
- **What it's not:** a photoreal renderer. Accurate scale and layout come first. Looks second.

### Where we are today

A static three.js editor (no build step, three.js loaded from a CDN with an import map), live at
<https://tmbradley.github.io/family-room-3d/>. It models one room:

- Family room: 12 ft wide × 13 ft deep, 9 ft ceilings
- Flush 5 ft fireplace centered on the left wall (4 ft + 5 ft + 4 ft)
- 5 ft window on the top (back) wall, 4 ft from the fireplace corner
- Right side fully open to a 3 ft walkway, then 2.5 ft to the kitchen / nook
- Honey oak floors (staying)
- Drag, rotate, and delete furniture. Autosaves to `localStorage`. JSON import/export.
  The furniture list lives in `catalog.js`.

---

## 2. Core model: "Current" plus design workspaces

- **Current:** the house as it is today. That means walls, openings, ceiling heights, floor and
  wall colors, fixtures, and **the furniture that's there now** (Decided). It comes from scans or manual entry. It's **locked** in normal
  use and only changes on purpose, like after a rescan or a measurement fix.
- **Workspaces:** design ideas copied from Current, like "Classic MCM" or "Moody den." A workspace
  can cover one room or several. Inside it you can move furniture, change colors, and swap pieces
  without touching Current or any other workspace.
- **Structure vs. design:** each workspace stores only its **design layer** (furniture placements,
  colors, notes, shopping list) and points at Current for **structure** (walls, openings). When
  Current changes, every workspace picks up the new structure automatically.
- **Existing furniture in designs (Decided):** every design marks each Current piece as **keep**,
  **replace** (with a link to the new piece), or **remove**. Kept pieces stay in place unless moved
  and cost $0. Replaced and removed pieces drop out of that design's view, and the new pieces go on
  its shopping list.
- **When structure changes break a design:** if a rescan moves a wall and furniture ends up
  outside the room or overlapping a wall or opening, the editor flags those pieces in that
  workspace. It doesn't move them silently.
- **Structural ideas (optional, later):** a workspace may also override structure, for example
  "what if we widen this opening." Overrides are stored as explicit changes on top of Current, so
  rescans still apply everywhere else.

---

## 3. UI: tabs, split view, sync

- **Tabs:** one tab per workspace, with **Current** always first and shown as locked. Tabs can be
  added (copied from Current or from another workspace), renamed, duplicated, and deleted.
- **Split view:** show any two tabs side by side. On a phone, stack them top and bottom.
- **Sync toggle:** when on, both panes share one camera. Orbit angle, zoom, pan, and top/3D mode
  stay identical, whichever pane you move. When off, each pane has its own camera.
- **Follow selected room (optional):** with sync on, selecting a room in one pane frames the
  same room in the other.
- **Swipe / blend compare (later):** one viewport with a slider that wipes or fades between two
  tabs. Useful, but split view covers the main need first.

---

## 4. Structure editing tools

These tools edit **Current**, or a workspace's structural overrides. They're needed for manual entry
and for cleaning up scans.

| Tool | What it does |
|---|---|
| Wall edit | Drag wall endpoints. Type an exact length. Set height per room. |
| Openings | Add, move, resize, or delete windows, doors, and open spans. Set sill and head heights. |
| Room align | Move, rotate, and snap a room so its edges meet a neighboring room's. Used for stitching. |
| Measure | Click two points to get a distance, to check against a tape measure. |
| Labels | Name each room. Labels show in the plan view. |
| Colors | Set floor and wall colors per room, picked from a photo or entered as a hex code. |

Edits snap to 1" by default (toggle off for free placement). Every edit can be undone.

---

## 5. Furniture and shopping lists

- **Catalog:** furniture lives in the `furniture_items` table in MySQL (section 6). Each item is
  one piece: name, kind (sofa, chair, table, rug, lamp, ...), width, depth, and height in inches,
  color, store, product URL, price, image, and a status like idea / shortlisted / bought.
- **Notion (optional):** Michael's private ("personal") Notion can be a friendly view or editor for
  the catalog and shopping lists, synced by the bot. Whether Notion stays in the loop is an open
  question (section 11). The "personal" connection currently signs into the Classroom Mosaic workspace
  and needs a fresh sign-in either way. Until P4, `catalog.js` stays the source.
- **Shopping list per workspace:** every piece placed in a workspace that isn't already in Current,
  with link, price, quantity, and a total. Pieces marked "keep" from Current show as $0.
  Exportable as CSV.

### Cost to change the room (Decided)

No budget is set yet. Instead, every design gets a **cost-to-change estimate**: a step-by-step
breakdown of what it takes to turn Current into that design. Each step says what changes and gives a
low/high cost range, followed by a total.

| Step | Example of what changes | Estimate |
|---|---|---|
| Paint | Walls greige → olive. Trim stays white. | $150 – $400 |
| Outlets & switch plates | Swap the almond ones for white or matte black | $40 – $120 |
| Lighting | Replace the black fan with a walnut-blade fan or flush mount. Add a floor lamp. | $250 – $700 |
| Window treatments | White blinds → linen roman shade | $120 – $350 |
| Furniture | New sofa and credenza. Keep the swivel chair ($0). | $1,800 – $3,500 |
| Rug | Gray geometric → wool flatweave 8×10 | $250 – $700 |
| Decor | Art, pillows, plants | $150 – $400 |
| **Total** | | **$2,760 – $6,170** |

(The numbers above only show the format. They aren't real estimates yet.)

- Steps come from a fixed list: paint, outlets/switch plates, lighting, window treatments,
  furniture, rug, decor, other. Steps with no changes are left out.
- Line items link to the catalog or shopping list where a real product is chosen. Those use the
  actual price as both low and high. Items that are still ideas use a range.
- Pieces marked **keep** cost $0. Removed pieces cost $0 (resale value isn't counted).
- The estimate recalculates whenever the design or a price changes. Each proposal shows its change
  to the total (section 7).

### Stores (task)

The bot will research a few budget-friendly sources of mid-century lookalikes besides West Elm,
checking price range, quality reviews, shipping, and returns. It will add only verified sources to
the catalog as a "store" option. The list isn't filled in here until that research is done.

---

## 6. Architecture and data storage (Decided: Railway + MySQL)

House data moves to **Railway** with a **MySQL** database. Michael already uses Railway for
other projects. This replaces the earlier plan of a private GitHub repo with a token pasted on each device.

### Pieces

```
 iPhone / laptop browser            Bot (daily routine, edits)        iOS App Clip (later)
        │  session cookie                 │  bot API key                    │  upload token
        ▼                                 ▼                                 ▼
 ┌──────────────────────────── Railway project "house-planner" ─────────────────────────────┐
 │  web+api service (Node + TypeScript, Hono)  ──►  MySQL     (house, workspaces, proposals) │
 │        serves the static editor + /api/*    ──►  Bucket    (scans, photos)                │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Editor:** stays a static three.js app with no build step. Two ways to host it:

  | Option | Pros | Cons |
  |---|---|---|
  | **Served by the Railway service** (recommended) | Same origin as the API, so login is a plain first-party cookie with no cross-site cookie problems in iPhone Safari. One deploy, one URL. | The editor is no longer on GitHub Pages (Pages can keep a read-only demo). |
  | GitHub Pages + API on Railway | Free static hosting, already live. | Different site from the API. Safari blocks cross-site cookies, so it needs either a custom domain with both on subdomains of one domain, or bearer tokens kept in the browser (less safe). |

  Recommendation: serve it from Railway, from the same repo's static files. Keep the Pages site as
  a public read-only demo with the default layout.

- **API server: Node + TypeScript with [Hono](https://hono.dev).** It's small, TypeScript-first, built on
  web standards (Request/Response), and runs well on Node on Railway. It has built-in middleware for
  cookies, CORS, and bearer auth, and a small dependency footprint suits an API with about a dozen
  routes. Fastify is a fine alternative with a bigger plugin ecosystem, but we don't need it here. Database access
  goes through **Prisma** (see ORM below).

- **Login (single user): passkeys.** Michael signs in with Face ID / Touch ID. Passkeys sync through
  iCloud Keychain, so iPhone and Mac both work with no passwords and no email service. The server
  issues an httpOnly, Secure, SameSite=Lax session cookie (30-day sliding expiry). Setup: a one-time
  `SETUP_CODE` env var lets the first passkey be registered, then it's turned off. Printed recovery
  codes cover a lost device. Magic links were considered, but they need an email provider and add a
  mail round trip on the phone.

- **Bot access:** a separate API key (`BOT_API_KEY`), stored as a Railway env var on the server and
  as a bot secret on the bot side. The key is limited to reading everything and **creating
  proposals, inspiration rows, and catalog syncs**. It can't approve proposals or change Current. Every
  bot write is tagged `actor = 'bot'`.

- **File storage: Railway's S3-compatible bucket (object storage)**, not a volume. A bucket isn't
  tied to one service, lets the App Clip and browser upload directly with presigned URLs, and egress
  is free. A volume would pin storage to one service and make redeploys and backups clumsier.

### Database schema (MySQL, fully relational)

**Approach:** model-based and normalized. Every entity is its own table with a primary key and
foreign keys. There are **no JSON columns**: geometry, proposal changes, history, and costs are all
rows and typed columns.
Engine: InnoDB (foreign keys, transactions), `utf8mb4`.

**How geometry is modeled relationally**

- **Units:** all lengths are stored as **integer inches**. 12 ft = 144, 13 ft = 156, 9 ft = 108.
  That avoids floating-point drift, and 1" is finer than we can measure. The UI shows feet and inches.
- **Rooms** have a position and rotation in the house plan (`origin_x_in`, `origin_y_in`,
  `rotation_deg`) and a ceiling height. Each room's walls use room-local coordinates, so moving or
  rotating a room when stitching only changes three columns.
- **Walls** are rows with start and end points: `start_x_in, start_y_in, end_x_in, end_y_in`, plus
  `height_in` and `thickness_in`. Length is computed. A wall-length edit moves an endpoint. An
  **open edge** (like the family room's open right side) is a wall row with `is_open = 1`, so the
  room outline is always closed and rooms can be stitched along it.
- **Openings** reference a wall: `wall_id`, `type` (window/door/open_span/fireplace),
  `offset_in` (from the wall's start point), `width_in`, `sill_in`, `head_in`. Moving a window is
  one column update. Deleting a wall cascades to its openings.
- **Furniture placements** store `x_in, y_in` (center, room-local), `rotation_deg`, and `room_id`.
  Sizes come from the furniture item.

**Tables**

| Table | Columns (FK → table) | Notes |
|---|---|---|
| `houses` | id, name, current_revision | One row for now. |
| `rooms` | id, house_id → houses, slug, label, origin_x_in, origin_y_in, rotation_deg, ceiling_in, floor_material, floor_color, wall_color, trim_color | Structure for Current. |
| `walls` | id, room_id → rooms, start_x_in, start_y_in, end_x_in, end_y_in, height_in, thickness_in, is_open, label | |
| `openings` | id, wall_id → walls, type, offset_in, width_in, sill_in, head_in, treatment, notes | Treatment examples: "white horizontal blinds". |
| `fixtures` | id, room_id → rooms, type (ceiling_fan/outlet/switch/light), name, color, x_in, y_in, wall_id → walls (nullable), count | Fan, outlets, switch plates. |
| `room_links` | id, wall_a_id → walls, wall_b_id → walls, offset_in | Records that two rooms meet along these walls (stitching). |
| `workspaces` | id, house_id → houses, name, notes, base_revision, revision, created_by (michael/bot), source_proposal_id → proposals (nullable) | Base is always Current. `base_revision` = the Current revision it was last reconciled with. |
| `workspace_rooms` | workspace_id → workspaces, room_id → rooms | Which rooms a workspace covers (many-to-many). |
| `workspace_room_styles` | workspace_id, room_id, wall_color, trim_color, floor_color | Per-design color overrides. Missing = same as Current. |
| `structure_overrides` | id, workspace_id, entity_type (wall/opening), entity_id (nullable for added), field, value | Optional "what if" structure edits inside a design (P3+). |
| `stores` | id, name, url, notes | Filled in after the store research. |
| `furniture_items` | id, kind, name, w_in, d_in, h_in, color, store_id → stores, url, price_cents, image_url, status (idea/shortlisted/bought/existing), notion_page_id | The catalog. Current's furniture is items with status `existing`. |
| `placements` | id, workspace_id → workspaces (NULL = Current), room_id → rooms, item_id → furniture_items, x_in, y_in, rotation_deg, action (keep/replace/remove/new), replaces_placement_id → placements | Keep/replace/remove decisions on Current's pieces live here. |
| `proposals` | id, house_id, created_at, created_by, source_kind (x_bookmark/bot/manual), source_url, source_image_url, inspiration_id → inspiration, target_workspace_id → workspaces (NULL = new), new_workspace_name, title, rationale, cost_low_cents, cost_high_cents, status (proposed/approved/rejected/applied), decided_at, decision_note, base_revision | |
| `proposal_rooms` | proposal_id, room_id | Target room(s). |
| `proposal_changes` | id, proposal_id → proposals, seq, op (create/update/delete), entity_type (placement/opening/wall/room_style/…), entity_id (NULL for create), field, before_value, after_value, temp_ref | **One row per field change.** A new piece is one `create` with a `temp_ref` plus one row per field. |
| `revisions` | id, house_id, workspace_id (NULL = Current), number, created_at, actor (michael/bot), kind (save/proposal/rescan/rollback/seed), proposal_id → proposals, rolls_back_revision_id → revisions, note | **Append-only.** Unique (workspace_id, number). |
| `revision_changes` | id, revision_id → revisions, seq, op, entity_type, entity_id, field, before_value, after_value | Same shape as `proposal_changes`. Append-only. |
| `cost_estimates` | id, workspace_id → workspaces, total_low_cents, total_high_cents, computed_at, revision | Latest estimate per design. |
| `cost_steps` | id, estimate_id → cost_estimates, step (paint/outlets/lighting/window/furniture/rug/decor/other), sort, changes_text, low_cents, high_cents | One row per step. |
| `cost_step_items` | id, step_id → cost_steps, placement_id → placements (nullable), item_id → furniture_items (nullable), label, low_cents, high_cents | Line items. Kept pieces = 0. |
| `uploads` | id, house_id, room_id → rooms, kind (scan/photo), format (usdz/glb/roomplan_json/jpg/heic), bucket_key, bytes, status (uploaded/imported/rejected), uploaded_by, created_at | Files live in the bucket. The DB holds the key. |
| `inspiration` | id, x_post_id (unique), url, author_handle, post_text, bookmarked_at, classified_at, is_design | One row per X bookmark the routine handled. |
| `inspiration_media` | id, inspiration_id → inspiration, url, type | Images and video on the post. |
| `inspiration_rooms` | inspiration_id, room_id | The room(s) it was matched to. |
| `users`, `passkeys`, `sessions`, `upload_tokens` | the usual | Auth. One user. |

`before_value` / `after_value` are `VARCHAR` holding the field's value as text (a number of inches,
a hex color, an id, an enum). Each change row names its entity type and field, so the server
converts the value back to the column's real type when applying it. That keeps diffs and history
relational (one row per changed field, queryable: "every change to the sofa's position") without
a JSON column.

### ORM: Prisma

**Prisma** (with Prisma Migrate) on MySQL. The schema is a single declarative `schema.prisma` file
with models and relations, which fits the model-based design. Prisma Migrate generates SQL
migration files from model changes, and the generated client gives typed queries and nested
relation reads like "workspace with rooms, placements, and items". Its MySQL support is mature
and widely used. Drizzle was the alternative (lighter, closer to SQL). It's a good tool, but
Prisma's model-first schema and migration workflow match "model-based, fully relational" more
directly, and it's the easier one to read and maintain.

### Version history and rollback (append-only revisions)

- Every change to Current or a workspace is one transaction. It applies the field changes, bumps
  that scope's `revision` number, and inserts one `revisions` row plus one `revision_changes` row per
  changed field, with before and after values. Creates and deletes record every field of the row,
  so they can be reversed.
- **Approving a proposal** copies its `proposal_changes` into a new revision (`kind = 'proposal'`,
  linked by `proposal_id`) and marks the proposal `applied`.
- **History list:** read `revisions` for a workspace, newest first, with who did it (Michael, or the
  bot via an approved proposal) and why.
- **Undo one change:** build a new revision (`kind = 'rollback'`, `rolls_back_revision_id` set) whose
  changes are the original's rows reversed: swap before and after, create ↔ delete, applied in reverse
  `seq` order. It's refused, and shown as a conflict, if a later revision changed the same
  entity and field.
- **Restore to a point:** walk the revisions after that point from newest to oldest, collecting their
  reversed changes, and apply them as **one** new rollback revision. Nothing is ever updated or
  deleted in `revisions` / `revision_changes`, so a rollback can itself be rolled back.

### Phone / laptop sync

- **The server is the source of truth.** The browser keeps a draft copy in `localStorage` only so
  nothing is lost if a save fails or you're offline.
- **Optimistic saves:** the editor updates instantly, then sends the change with the
  `revision` it was based on (`If-Match`-style).
- **Conflict check:** if the server's revision is newer (the other device or an applied proposal
  changed it), the save returns `409` with the latest state. The editor reloads it and re-applies your
  unsaved edits where they don't overlap, or asks which version to keep.
- **Live updates (later, optional):** a server-sent events stream per house so an open tab refreshes
  when something changes elsewhere. Not needed for P1.

### The `tmbradley/house-data` repo

- Its `house.json` is the **seed for the first database migration** (P0). The same JSON shape stays
  as the **export/import format** for the whole house (Current, workspaces, placements).
- After that it becomes an **optional backup/export** target. A nightly job (or a button) exports the
  whole house to JSON and commits it there. If we decide backups aren't needed, the repo gets archived.
- **Until the API exists**, the bot's X bookmark routine writes proposals as JSON files to
  `house-data/proposals/`. Once the API is up (P1), it switches to `POST /api/proposals`, and those
  files are imported into the `proposals` table.

### Rough Railway cost (estimate)

Based on Railway's [pricing page](https://railway.com/pricing) as of Oct 17, 2026. Usage is billed per
second: about $10 per GB of RAM per month, $20 per vCPU per month, $0.15 per GB of volume, and
$0.015 per GB-month of object storage. Hobby is $5/mo with $5 of usage included. Pro is $20/mo per
workspace with $20 included.

| Item | Rough monthly use | Est. cost |
|---|---|---|
| Web+API service (idle most of the day, ~100–150 MB RAM) | | $1 – $2 |
| MySQL (~300–450 MB RAM, ~1 GB disk) | | $3 – $4.50 |
| Bucket (a few GB of scans and photos) | | < $0.10 |
| **Usage total** | | **≈ $4 – $7 / month** |

On Hobby that's mostly covered by the $5 included, so about **$5–8/month all-in**. If it goes in
Michael's existing Railway workspace, it shares that plan's included credit with his other projects, so
the extra cost is just the usage, about $4–7. *These are estimates. Actual cost depends on RAM use,
which we'll check after P0.*

---

## 7. Change management: proposals (Decided)

**Rule:** inspiration from the X bookmark routine, and any other bot suggestion, **never edits a
design directly**. It creates a **proposal** (a change request). Only Michael applies changes,
by approving them. The bot's API key can create proposals but can't approve them.

**What a proposal contains** (a row in `proposals`; before the API exists, a file in `house-data/proposals/`):

- **Source:** link to the X post or other origin, plus an image if there is one
- **Target:** room(s) and workspace, or "new workspace" with a suggested name
- **Changes:** `proposal_changes` rows, one per changed field, with **before / after** values (move this piece,
  replace that one, change wall color, add an item). It's precise enough to apply automatically.
- **Rationale:** why it fits the room and the design style
- **Cost impact:** the change to that design's cost-to-change total (low/high)
- **Status:** `proposed` → `approved` or `rejected` → `applied`, with dates and an optional
  comment from Michael

**In the editor: a Proposals panel**

- Lists open proposals with a count badge, newest first. You can filter by room or workspace.
- Opening one shows a **visual before/after in split view**: the workspace as it is on the left
  and the workspace with the proposal applied on the right, with camera sync on. The change list,
  rationale, and cost impact are shown underneath.
- **Approve** applies the changes to the workspace as a new revision. For "new workspace," it creates the
  workspace from Current plus the changes. **Reject** keeps the proposal with status `rejected` and an
  optional reason, so the bot learns what you don't want.
- If the workspace changed since the proposal was written (its `base_revision` is behind) and a
  "before" value no longer matches, the editor flags it and won't apply it blindly. You can still
  apply the parts that match, or reject it.

**History and rollback:** every applied proposal and every save is an append-only revision
(section 6). Each workspace and Current has a History list with undo and restore.

## 8. Scanning (later phase, not now)

Scanning is deferred. Planning and the editor come first.

**Step 1: import existing scans.** Scan a room with Polycam (Room mode), which uses Apple's RoomPlan
on LiDAR iPhones, then export and upload in the editor:

- Preferred: **RoomPlan JSON** if available, since it has walls, openings, and sizes as clean data.
- Also: **USDZ / GLB**, which the importer reads for wall and opening objects.
- The file goes to the bucket (an `uploads` row). The importer converts the scan into rooms, walls,
  and openings, checks it against known measurements (for example the family room's 12 × 13 ft), and
  lets you place it with the room-align tool. Nothing changes Current until you confirm, which is
  then a `rescan` revision.

**Step 2: iOS App Clip for scanning.**

- What's available: an Apple Developer account, a LiDAR iPhone Pro, and a Mac with Xcode set up.
- Flow: tap "Scan room" in the web app (or scan a QR code) → the App Clip opens → RoomPlan scan →
  the clip asks the **Railway API** for a presigned upload URL, uploads the RoomPlan JSON / USDZ to
  the bucket, and registers it → the editor shows it as ready to import.
- Auth for the clip: the "Scan room" link carries a short-lived, single-use upload token created by
  the logged-in editor. No login inside the clip.
- Requirements: an App Clip must ship inside a full parent app that passes App Store review. The
  parent can be minimal, like a simple room viewer. The clip has a size limit, and a
  scan-and-upload screen fits within it.
- **First task in this phase:** confirm RoomPlan works inside an App Clip with a minimal TestFlight
  build before building anything else. If it doesn't, fall back to a small full app distributed
  through TestFlight.

**Per room, always capture both:** one LiDAR scan for geometry, plus 4–6 daylight photos (corners,
plus any feature wall) for true colors and details like floor tone, trim, outlets, and the
fireplace finish. Photos are stored as `uploads` too.

---

## 9. Inspiration pipeline (X bookmarks)

**What already runs:** a daily routine (about 7 PM ET) reads new X bookmarks and handles each one in order:

1. Skip anything that isn't about home design.
2. Decide which room or rooms it applies to (it can be more than one).
3. Compare it with that room's existing design workspaces. If it fits one, write a **proposal**
   targeting that workspace. If not, write a proposal for a **new workspace**. Nothing is applied
   until Michael approves it (section 7). **Current is never changed.**
4. Post a short note listing each bookmark and the proposal it produced. Nothing on days with no
   design bookmarks.

**Where its output goes, by stage:**

- **Now:** designs are noted in the bot's store
  (`/cursor/stores/store-87e031d1-b2f2-435c-b46f-6636a178fa2c/home-design/designs.json`), and
  proposals are written as JSON files to `tmbradley/house-data/proposals/`.
- **Once the API exists (P1):** the routine calls `POST /api/inspiration` and `POST /api/proposals`
  with the bot API key. The existing files and `designs.json` entries are imported once as proposals
  (mostly "new workspace"), not applied directly. Any that need furniture get placeholder catalog
  pieces, labeled as placeholders.
- Workspaces created or changed by an approved proposal link back to it in their History.

---

## 10. Phased roadmap

Changes from the last version:

- **New P0 for Railway setup**, since everything after it reads and writes the database.
- **Proposals start in P1** (API, bot switch-over, basic approve/reject list) and get the visual
  split-view panel in P2, because the daily routine is already running.
- **History and rollback** come with the revisions table in P1. The History list UI comes in P2.
- **Cost-to-change estimates ship with shopping lists in P4.**

### P0: Railway setup
- Railway project with MySQL and a bucket. One Hono (TypeScript) service that serves the static
  editor and `/api/*`. Deploys automatically from the repo's `main` branch.
- Prisma schema and migrations for the tables in section 6.
- Passkey login with a one-time setup code and recovery codes. Session cookie. `BOT_API_KEY` for the bot.
- Seed script: import `tmbradley/house-data/house.json` into the relational tables, converting feet to
  integer inches (the family room as Current, with existing furniture). Recorded as revision 1 (`kind = 'seed'`).
- Health check and a nightly JSON export (to the bucket, and optionally committed to `house-data`).

**Done when:** the editor loads from the Railway URL, you can sign in with Face ID on the iPhone and
Touch ID on the Mac, `GET /api/house` returns the seeded family room, an unauthenticated request
gets `401`, and a bot-key request can read but can't approve proposals.

### P1: House data model in the editor, Current + workspace tabs, proposals API
- The editor loads the house from the API instead of `catalog.js` defaults, and the family room
  looks identical to today, including the existing furniture.
- Tab bar: Current (locked) first, then workspaces. Add, duplicate, rename, and delete tabs.
- Saves go to the API with optimistic updates and revision-number conflict checks.
  `localStorage` keeps drafts. Every save is an append-only revision.
- Each workspace marks every Current piece keep / replace / remove.
- Proposals, basic version: `POST /api/proposals` for the bot. The editor lists proposals with
  source link, target, change list, and rationale, with Approve/Reject. Import the existing
  `house-data/proposals/` files and `designs.json` entries. Switch the daily routine over to the API.

**Done when:** you create two workspaces, move furniture in one without affecting Current or the
other, save on the laptop, and see it on the phone after reload. Editing the same workspace on both
devices produces a conflict prompt, not lost work. The next bookmark from the daily routine arrives
through the API as a proposal. Approving it changes (or creates) the target workspace, and
rejecting it changes nothing.

### P2: Split view + camera sync + Proposals panel + History UI
- Show any two tabs side by side (stacked on a phone).
- Sync toggle: shared orbit angle, zoom, pan, and top/3D mode.
- Optional: follow selected room.
- Proposals panel opens each proposal as a before/after split view with sync on. Rejected proposals
  keep the reason, and a proposal whose "before" values no longer match gets flagged.
- History list for every workspace (and for Current), with undo-one-change and restore-to-point.

**Done when:** with sync on, rotating, zooming, panning, or switching top/3D in either pane makes the
other match exactly. With sync off, the panes move independently. It works on iPhone Safari and desktop.
Opening a proposal shows the workspace before and after side by side. Approving it adds a History entry,
and rolling back that entry restores the workspace exactly.

### P3: Structure editing tools
- Wall edit, openings, measure, labels, colors from photo (section 4). Undo and redo.
- Structural changes apply to Current only after an explicit "Edit Current" unlock. Workspaces
  inherit the changes, and pieces that end up misplaced get flagged.

**Done when:** you can draw a new rectangular room with a door and a window to within 1" of tape
measurements, and a measurement fix on Current shows up in every workspace.

### P4: Furniture catalog + shopping lists + cost to change
- Furniture catalog in `furniture_items`, with an optional Notion sync depending on the open
  question below.
- Per-workspace shopping list with links, prices, and totals. CSV export.
- Cost-to-change estimate for every design: steps (paint, outlets/switch plates, lighting, window
  treatments, furniture, rug, decor), what changes in each step, a low/high range, and a total.
  Kept pieces cost $0. Proposals show their cost impact.
- Research a few budget-friendly mid-century lookalike stores besides West Elm, and add the verified ones.

**Done when:** adding an item to the catalog makes it placeable in the editor. Placing it in a
workspace adds it to that workspace's shopping list and updates its cost-to-change breakdown and
total. Marking a Current piece "keep" shows it at $0.

### P5: Multi-room house + stitching
- Several rooms in one house, using the room-align tool to snap shared edges (family room → walkway → kitchen/nook).
- A whole-house plan view, plus room-by-room focus.

**Done when:** the family room and kitchen/nook are placed together with the walkway between them at
the measured widths (3 ft walkway + 2.5 ft), and a workspace can span both rooms.

### P6: Scan import
- Upload RoomPlan JSON, USDZ, or GLB from Polycam to the bucket through the API. Check against known
  sizes. Align, then confirm into Current as a `rescan` revision.

**Done when:** a Polycam scan of the family room imports within about 2" of the confirmed
12 × 13 ft with the fireplace and window in the right places, and you can fix any errors with P3 tools.

### P7: iOS App Clip scanner
- TestFlight spike: does RoomPlan run in an App Clip? Then build the parent app + clip. The clip
  uploads to the Railway API with a single-use upload token.

**Done when:** from the iPhone, tapping "Scan room" opens the clip, completes a scan, and the room
appears in the editor ready to confirm, with no manual file transfer.

---

## 11. Open questions for Michael

Answered and folded in: storage (Railway + MySQL, fully relational), room order (decide as we go), existing
furniture in Current (yes, with keep / replace / remove), budget (none yet, so cost-to-change
estimates instead), stores (bot researches them), and bot edits (proposals only).

Still open:

1. The furniture sizes and positions in `house.json` are estimates from photos. Could you measure the
   sectional (both arms), the swivel chair, the rug, and the two TVs? And which wall are the TVs on?
2. Do you want to approve proposals from your phone as often as from the laptop? If so, the
   Proposals panel gets designed phone-first.
3. **Furniture: Notion or MySQL?** My recommendation is **MySQL as the source of truth**, edited in
   the planner, with Notion as an optional one-way view if you like browsing there. That gives one
   place for prices and shopping lists and avoids two-way sync conflicts. The personal Notion
   connection also still points at the wrong workspace. Or would you rather keep editing furniture in
   Notion, with the bot syncing it in?
4. **Railway:** which Railway workspace or team should this go in (Hobby or Pro)? New project or an
   existing one?
5. **Domain:** use the default `*.up.railway.app` URL, or a custom domain/subdomain you own? A
   custom domain also makes GitHub Pages + API workable if you want to keep Pages.
6. **Editor hosting:** OK to serve the editor from Railway (recommended, for simpler login) and keep
   GitHub Pages as a read-only demo?
