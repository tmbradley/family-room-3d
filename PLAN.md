# House Design Planner: Project Plan

Status: draft, with Michael's answers folded in · Last updated: Oct 17, 2026

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
the Notion database as a "store" option. The list isn't filled in here until that research is done.

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
      "currentFurniture": {                    // decision for each Current piece
        "sectional": { "action": "replace", "with": "sofa-mcm-84" },
        "swivel":    { "action": "keep" },
        "rug":       { "action": "remove" }
      },
      "placements": [
        { "room": "family", "catalogId": "sofa-mcm-84", "x": 10.0, "z": 6.5, "rot": 270 }
      ],
      "costEstimate": {
        "steps": [
          { "step": "paint", "changes": "Walls greige -> olive", "low": 150, "high": 400 },
          { "step": "furniture", "changes": "New 84in sofa; keep swivel chair", "low": 1200, "high": 2200,
            "items": [ { "catalogId": "sofa-mcm-84", "low": 1200, "high": 2200 },
                       { "currentId": "swivel", "action": "keep", "low": 0, "high": 0 } ] }
        ],
        "total": { "low": 1350, "high": 2600 },
        "updatedAt": "2026-10-17T21:00:00Z"
      },
      "history": []                           // ids of applied proposals / saves, newest last
    }
  ]
}
```

### Where it lives (Decided)

**A private repo, [`tmbradley/house-data`](https://github.com/tmbradley/house-data).** The public app
repo holds only code.

```
house-data/
  house.json        Current + all workspaces
  proposals/        one JSON file per change request (section 7)
  history/          one JSON file per applied change, used for rollback
  catalog.json      furniture synced from Notion (P4)
```

- The app reads and writes these files through the **GitHub contents API**. Each device needs a
  **fine-grained GitHub token**, pasted once, with access to `house-data` only (contents
  read/write). The token stays in that browser.
- Edits autosave to `localStorage` as drafts. **Save** commits to `house-data`. **Load** pulls the
  latest version.
- If the file changed on GitHub since the last load (from the other device or from the bot), the
  app asks before overwriting instead of losing either version.
- The bot reads and writes the same repo with `gh`. Git history doubles as a backup.
- Notion stays the place for furniture and inspiration a person browses. It isn't the source of
  truth for geometry.
- **Seeded:** `house.json` already has the family room as Current: walls, fireplace, window, open
  edge, greige walls, white trim, honey oak floors, black ceiling fan, white blinds, and the
  existing furniture (charcoal L-sectional, matching round swivel chair, gray geometric rug, dual
  stacked TVs). Sizes and positions estimated from photos are flagged `"approx": true`.

Other options we considered: `localStorage` only (one device, and the bot can't see it), JSON in
the public repo (exposes the house layout), and Notion as the store (the browser can't call Notion
without a server, and it's a poor fit for geometry).

---

## 7. Change management: proposals (Decided)

**Rule:** inspiration from the X bookmark routine, and any other bot suggestion, **never edits a
design directly**. It creates a **proposal** (a change request). Only Michael applies changes,
by approving them.

**What a proposal contains** (one file in `house-data/proposals/`):

- **Source:** link to the X post or other origin, plus an image if there is one
- **Target:** room(s) and workspace, or "new workspace" with a suggested name
- **Changes:** a list of specific edits with **before / after** values (move this piece, replace
  that one, change wall color, add an item). It's precise enough to apply automatically.
- **Rationale:** why it fits the room and the design style
- **Cost impact:** the change to that design's cost-to-change total (low/high)
- **Status:** `proposed` → `approved` or `rejected` → `applied`, with dates and an optional
  comment from Michael

**In the editor: a Proposals panel**

- Lists open proposals with a count badge, newest first. You can filter by room or workspace.
- Opening one shows a **visual before/after in split view**: the workspace as it is on the left
  and the workspace with the proposal applied on the right, with camera sync on. The change list,
  rationale, and cost impact are shown underneath.
- **Approve** applies the changes to the workspace. For "new workspace," it creates the workspace
  from Current plus the changes. **Reject** keeps the file with status `rejected` and an optional
  reason, so the bot learns what you don't want.
- If the workspace changed since the proposal was written and a "before" value no longer
  matches, the editor flags it and won't apply it blindly. You can still apply the parts that match,
  or reject it.

**History and rollback**

- Every applied proposal (and every manual save of a workspace) writes an entry to
  `house-data/history/` with what changed and the before values.
- Each workspace has a History list. **Roll back** reverses one entry (if later changes don't
  conflict) or restores the workspace to how it was at that point.
- Current has its own history for rescans and measurement fixes.

## 8. Scanning (later phase, not now)

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

## 9. Inspiration pipeline (X bookmarks)

**What already runs:** a daily routine (about 7 PM ET) reads new X bookmarks and handles each one in order:

1. Skip anything that isn't about home design.
2. Decide which room or rooms it applies to (it can be more than one).
3. Compare it with that room's existing design workspaces. If it fits one, write a **proposal**
   targeting that workspace. If not, write a proposal for a **new workspace**. Nothing is applied
   until Michael approves it (section 7). **Current is never changed.**
4. Post a short note listing each bookmark and the proposal it produced. Nothing on days with no
   design bookmarks.

**Until the editor supports workspaces**, designs are tracked by the bot in
`/cursor/stores/store-87e031d1-b2f2-435c-b46f-6636a178fa2c/home-design/designs.json` (bot-side
storage, not in this repo). Each entry has the room(s), workspace name, a description of the
change, colors, furniture ideas, and the source bookmark URL.

**How the editor will consume it:**

- As of P1, the bot writes **proposals** to `house-data/proposals/` instead of `designs.json` and
  commits them. They show up in the Proposals panel (P2), and Michael approves or rejects them there.
- Existing entries in `designs.json` are converted once into proposals (mostly "new workspace"), not
  applied directly. Any that need furniture get placeholder catalog pieces, labeled as placeholders.
- Inspiration notes and images can also go to a Notion board for browsing, once the personal
  Notion connection is fixed.
- Workspaces created or changed by an approved proposal link back to it in their History.

---

## 10. Phased roadmap

The suggested order is mostly kept, with these changes:

- **Data sync moves into P1**, because phone/laptop use and the bot both depend on it.
- **Proposals start in P1 and P2**, because the daily routine is already running. In P1 the bot
  writes proposals to `house-data` and the editor lists them with Approve/Reject. In P2 the panel
  gets the visual before/after in split view, plus history and rollback.
- **Cost-to-change estimates ship with shopping lists in P4.**

### P1: House data model, Current + workspace tabs, family room migration
- Define `house.json` (section 6). Move the family room into it: walls, fireplace, window, open edge, and the existing furniture as Current.
- Tab bar: Current (locked) first, then workspaces. Add, duplicate, rename, and delete tabs.
- Save and load against `tmbradley/house-data` with a per-device token, `localStorage` drafts, and
  a conflict prompt.
- Current includes existing furniture. Each workspace marks every Current piece keep / replace / remove.
- Proposals, basic version: the bot writes proposals to `house-data/proposals/`. The editor lists
  them with source link, target, change list, and rationale, with Approve/Reject buttons that apply
  the change or mark it rejected. The bot's `designs.json` entries are converted into proposals.

**Done when:** the live site loads the family room from `house.json` and it looks identical to
today, including the existing furniture. You can create two workspaces, move furniture in one
without affecting Current or the other, save on the laptop, and see it on the phone after reload.
A bookmark from the daily routine shows up as a proposal. Approving it changes (or creates) the
target workspace. Rejecting it changes nothing.

### P2: Split view + camera sync + Proposals panel
- Show any two tabs side by side (stacked on a phone).
- Sync toggle: shared orbit angle, zoom, pan, and top/3D mode.
- Optional: follow selected room.
- Proposals panel opens each proposal as a before/after split view with sync on. Rejected proposals
  keep the reason, and a proposal whose "before" values no longer match gets flagged.
- History for every workspace (and for Current), with rollback.

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

### P4: Notion furniture catalog + shopping lists + cost to change
- Fix the personal Notion connection. Create the furniture database. The bot syncs it to `catalog.json`.
- Per-workspace shopping list with links, prices, and totals. CSV export.
- Cost-to-change estimate for every design: steps (paint, outlets/switch plates, lighting, window
  treatments, furniture, rug, decor), what changes in each step, a low/high range, and a total.
  Kept pieces cost $0. Proposals show their cost impact.
- Research a few budget-friendly mid-century lookalike stores besides West Elm, and add the
  verified ones to Notion.

**Done when:** adding a row in Notion shows up in the editor's catalog after a sync. Placing it in
a workspace adds it to that workspace's shopping list and updates its cost-to-change breakdown and
total. Marking a Current piece "keep" shows it at $0.

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

## 11. Open questions for Michael

Answered and folded in: storage (private `house-data` repo), room order (decide as we go),
existing furniture in Current (yes, with keep / replace / remove), budget (none yet, so
cost-to-change estimates instead), stores (bot researches them), and bot edits (proposals only).

Still open:

1. The furniture sizes and positions in `house.json` are estimates from photos. Could you measure the
   sectional (both arms), the swivel chair, the rug, and the two TVs? And which wall are the TVs on?
2. Do you want to approve proposals from your phone as often as from the laptop? If so, the
   Proposals panel gets designed phone-first.
