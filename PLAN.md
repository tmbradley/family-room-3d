# House Design Planner: Project Plan

Status: draft for discussion · Last updated: Oct 17, 2026

This plan describes how the current single-room editor grows into a planner for the whole house.
Each phase lists what gets built and how we'll know it's done. Nothing here is final. Open
questions are listed at the end.

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
  wall colors, and existing furniture. It comes from scans or manual entry. It's **locked** in normal
  use and only changes on purpose, like after a rescan or a measurement fix.
- **Workspaces:** design ideas copied from Current, like "Classic MCM" or "Moody den." A workspace
  can cover one room or several. Inside it you can move furniture, change colors, and swap pieces
  without touching Current or any other workspace.
- **Structure vs. design:** each workspace stores only its **design layer** (furniture placements,
  colors, notes, shopping list) and points at Current for **structure** (walls, openings). When
  Current changes, every workspace picks up the new structure automatically.
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

- **Catalog source:** a Notion database in Michael's private ("personal") Notion. Each row is one
  piece: name, kind (sofa, chair, table, rug, lamp, ...), width, depth, and height in inches,
  color, store, product URL, price, image, and a status like idea / shortlisted / bought.
- **Connection status:** the "personal" Notion connection currently signs into the Classroom
  Mosaic workspace instead of the private one. It needs a fresh sign-in, choosing the private
  workspace before approving. Until then, `catalog.js` stays the source.
- **How the catalog reaches the app:** the browser can't call Notion directly (no browser
  access/CORS, and the token must stay secret). So the bot syncs the Notion database into a
  `catalog.json` file in the data store (see section 6), and the app reads that. `catalog.js`
  becomes the fallback.
- **Shopping list per workspace:** every piece placed in a workspace that isn't already in Current,
  with link, price, quantity, and a total. Pieces marked "keep" from Current show as $0.
  Exportable as CSV.

---

## 6. Data storage

### House file format (JSON)

One file per house. Units are feet for positions and inches for furniture sizes, as the app uses today.

```jsonc
{
  "version": 1,
  "house": { "name": "Bradley house", "units": "ft" },
  "current": {
    "updatedAt": "2026-10-17T21:00:00Z",
    "rooms": [
      {
        "id": "family",
        "label": "Family room",
        "origin": { "x": 0, "z": 0 }, "rotation": 0,
        "ceiling": 9,
        "floor": { "material": "oak", "color": "#c8913f" },
        "wallColor": "#cfc6b8",
        "walls": [
          { "id": "w-left", "a": [0, 0], "b": [0, 13], "height": 9 },
          { "id": "w-back", "a": [0, 13], "b": [12, 13], "height": 9 }
        ],
        "openings": [
          { "id": "fireplace", "wall": "w-left", "type": "fireplace", "offset": 4, "width": 5 },
          { "id": "win-1", "wall": "w-back", "type": "window", "offset": 4, "width": 5, "sill": 2.5, "head": 7.5 }
        ],
        "openEdges": [ { "a": [12, 0], "b": [12, 13], "to": "walkway" } ],
        "furniture": [ /* existing pieces, same shape as placements below */ ]
      }
    ]
  },
  "workspaces": [
    {
      "id": "classic-mcm",
      "name": "Classic MCM",
      "rooms": ["family"],
      "createdFrom": "current",
      "source": { "kind": "manual" },          // or { "kind": "x-bookmark", "url": "..." }
      "notes": "",
      "colors": { "family": { "wallColor": "#8a8f7a" } },
      "structureOverrides": [],
      "placements": [
        { "room": "family", "catalogId": "sofa", "x": 10.0, "z": 6.5, "rot": 270 }
      ]
    }
  ]
}
```

### Where it lives: options

GitHub Pages only serves static files, so saving from the browser needs somewhere to write to.

| Option | Pros | Cons |
|---|---|---|
| A. `localStorage` only | Simple. Already works. | Stuck on one device. Easy to lose. The bot can't see it. |
| B. JSON in this public repo, saved through the GitHub API | Version history for free. The bot edits it with `gh`. Works from phone and laptop. | Public repo means the house layout is public. Each device needs a token. |
| C. JSON in a **separate private repo** (e.g. `tmbradley/house-data`), saved through the GitHub API | Same as B, but private. Version history. The bot can read and write it. | Each device needs a fine-grained token (scoped to that one repo) stored in the browser. |
| D. Notion as the store | Already the furniture database. Easy to browse. | Browser can't call Notion without a server or proxy. Poor fit for nested geometry. No real history. |

### Recommendation: C, with `localStorage` for drafts

- The house file (`house.json`), synced `catalog.json`, and inspiration data live in a private
  `house-data` repo. The public app stays code only.
- Edits autosave to `localStorage` right away. **Save** commits the file through the GitHub
  contents API (one commit per save, with a short message). **Load** pulls the latest version.
- If the file changed on GitHub since your last load (from the other device or from the bot), the
  app asks before overwriting instead of losing either version.
- Setup per device: paste a fine-grained GitHub token once (access to `house-data` only,
  contents read/write). It stays in that browser.
- Notion stays the place for furniture and inspiration notes that a person browses. It isn't the
  source of truth for geometry.

---

## 7. Scanning (later phase, not now)

Scanning is deferred. Planning and the editor come first.

**Step 1: import existing scans.** Scan a room with Polycam (Room mode), which uses Apple's RoomPlan
on LiDAR iPhones, then export and upload in the editor:

- Preferred: **RoomPlan JSON** if available, since it has walls, openings, and sizes as clean data.
- Also: **USDZ / GLB**, which the importer reads for wall and opening objects.
- The importer converts the scan into the house format, checks it against known measurements (for
  example the family room's 12 × 13 ft), and lets you place it with the room-align tool. Nothing
  overwrites Current until you confirm.

**Step 2: iOS App Clip for scanning.**

- What's available: an Apple Developer account, a LiDAR iPhone Pro, and a Mac with Xcode set up.
- Flow: tap "Scan room" in the web app (or scan a QR code) → the App Clip opens → RoomPlan scan →
  the result uploads to the data store → the editor imports it.
- Requirements: an App Clip must ship inside a full parent app that passes App Store review. The
  parent can be minimal, like a simple room viewer. The clip has a size limit, and a
  scan-and-upload screen fits within it.
- **First task in this phase:** confirm RoomPlan works inside an App Clip with a minimal TestFlight
  build before building anything else. If it doesn't, fall back to a small full app distributed
  through TestFlight.
- Upload target: the same private data repo through the GitHub API, so no new server is needed.

**Per room, always capture both:** one LiDAR scan for geometry, plus 4–6 daylight photos (corners,
plus any feature wall) for true colors and details like floor tone, trim, outlets, and the
fireplace finish.

---

## 8. Inspiration pipeline (X bookmarks)

**What already runs:** a daily routine (about 7 PM ET) reads new X bookmarks and handles each one in order:

1. Skip anything that isn't about home design.
2. Decide which room or rooms it applies to (it can be more than one).
3. Compare it with that room's existing design workspaces. If it fits one, tweak that workspace.
   If not, create a new workspace for it. **Current is never changed.**
4. Post a short note listing each bookmark and what happened to it. Nothing on days with no
   design bookmarks.

**Until the editor supports workspaces**, designs are tracked by the bot in
`/cursor/stores/store-87e031d1-b2f2-435c-b46f-6636a178fa2c/home-design/designs.json` (bot-side
storage, not in this repo). Each entry has the room(s), workspace name, a description of the
change, colors, furniture ideas, and the source bookmark URL.

**How the editor will consume it:**

- After phase 1, the bot writes designs straight into `house.json` as workspaces, each with
  `source: { kind: "x-bookmark", url }`, and commits to the data repo. They show up as tabs on the next load.
- Existing entries in `designs.json` get migrated once into workspaces. Any that need furniture
  get placeholder pieces from the catalog, labeled as placeholders.
- Inspiration notes and images can also go to a Notion board for browsing, once the personal
  Notion connection is fixed.
- Bot-created or bot-changed workspaces show a small "updated by bot" marker with the date until you open them.

---

## 9. Phased roadmap

The suggested order is mostly kept. Two changes: **data sync moves into P1**, because the
bot-driven workspaces and phone/laptop use both depend on it, and **the inspiration hookup moves
into P1** as well, since the daily routine is already producing designs.

### P1: House data model, Current + workspace tabs, family room migration
- Define `house.json` (section 6). Move the family room into it: walls, fireplace, window, open edge, and the existing furniture as Current.
- Tab bar: Current (locked) first, then workspaces. Add, duplicate, rename, and delete tabs.
- Save and load against the private data repo, with `localStorage` drafts and a conflict prompt.
- Import the bot's `designs.json` entries as workspaces.

**Done when:** the live site loads the family room from `house.json` and it looks identical to
today. You can create two workspaces, move furniture in one without affecting Current or the
other, save on the laptop, and see it on the phone after reload. Bot-created workspaces appear as tabs.

### P2: Split view + camera sync
- Show any two tabs side by side (stacked on a phone).
- Sync toggle: shared orbit angle, zoom, pan, and top/3D mode.
- Optional: follow selected room.

**Done when:** with sync on, rotating, zooming, panning, or switching top/3D in either pane makes the
other match exactly. With sync off, the panes move independently. It works on iPhone Safari and desktop.

### P3: Structure editing tools
- Wall edit, openings, measure, labels, colors from photo (section 4). Undo and redo.
- Structural changes apply to Current only after an explicit "Edit Current" unlock. Workspaces
  inherit the changes, and pieces that end up misplaced get flagged.

**Done when:** you can draw a new rectangular room with a door and a window to within 1" of tape
measurements, and a measurement fix on Current shows up in every workspace.

### P4: Notion furniture catalog + shopping lists
- Fix the personal Notion connection. Create the furniture database. The bot syncs it to `catalog.json`.
- Per-workspace shopping list with links, prices, and totals. CSV export.

**Done when:** adding a row in Notion shows up in the editor's catalog after a sync. Placing it in
a workspace adds it to that workspace's shopping list with the correct total.

### P5: Multi-room house + stitching
- Several rooms in one house, using the room-align tool to snap shared edges (family room → walkway → kitchen/nook).
- A whole-house plan view, plus room-by-room focus.

**Done when:** the family room and kitchen/nook are placed together with the walkway between them at
the measured widths (3 ft walkway + 2.5 ft), and a workspace can span both rooms.

### P6: Scan import
- Import RoomPlan JSON, USDZ, and GLB from Polycam. Check against known sizes. Align, then confirm into Current.

**Done when:** a Polycam scan of the family room imports within about 2" of the confirmed
12 × 13 ft with the fireplace and window in the right places, and you can fix any errors with P3 tools.

### P7: iOS App Clip scanner
- TestFlight spike: does RoomPlan run in an App Clip? Then build the parent app + clip, with upload to the data repo.

**Done when:** from the iPhone, tapping "Scan room" opens the clip, completes a scan, and the room
appears in the editor ready to confirm, with no manual file transfer.

---

## 10. Open questions for Michael

1. Is a separate **private data repo** (`tmbradley/house-data`) OK, with a one-time token paste on each device? Or are you fine keeping the house data public in this repo?
2. Which rooms come after the family room, in what order?
3. Should Current include the furniture you have today (charcoal sectional, swivel chair, TVs) so workspaces can mark pieces as "keep"?
4. A rough budget per room, for the shopping list to track against?
5. Favorite stores beyond West Elm for lookalikes (Article, Burrow, Target, IKEA, Facebook Marketplace...)?
6. Should the bot's inspiration updates edit existing workspaces directly, or create a "proposed" copy for you to accept?
