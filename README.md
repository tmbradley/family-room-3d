# Family Room 3D Layout Editor

A small static web app for trying furniture layouts in Michael's family room, modeled at real
dimensions (1 unit = 1 ft):

- Room 12 ft wide (fireplace wall → open side) × 13 ft deep, 9 ft ceilings
- One flush 5 ft fireplace centered on the left wall (4 ft · 5 ft · 4 ft)
- One 5 ft window on the back wall, 4 ft from the fireplace corner (sill 2.5 ft, top 7.5 ft)
- Right side fully open to a 3 ft walkway, then 2.5 ft toward the kitchen / nook
- Honey oak floors, warm greige walls, white trim

Built with plain HTML/CSS/JS and [three.js](https://threejs.org) loaded from a CDN via an import map,
so there is no build step and it runs as-is on GitHub Pages.

## Project plan

Where this is headed (whole-house planner, design workspaces, split view, scanning): see [PLAN.md](PLAN.md).

## Run locally

Any static file server works (ES modules don't load from `file://`):

```sh
cd family-room-3d
python3 -m http.server 8000
# open http://localhost:8000
```

`?view=top` opens straight into the overhead plan view.

## Use

- **Camera:** drag to orbit, scroll/pinch to zoom, right-drag / two-finger drag to pan. *Top view* is a true
  overhead orthographic plan; *3D view* goes back to the orbit camera.
- **Furniture:** tap a piece to select it, drag it across the floor, **R** or *Rotate 90°* to turn it,
  **Delete** / *Delete* to remove it, **Esc** to deselect. Snap to 3" can be toggled.
- The panel shows the selected piece's size and its clearance to each wall (and to the open edge).
- **Walls:** toggle between a 3 ft cutaway (default) and full 9 ft walls.
- **Layout:** autosaves to `localStorage`; Export / Import JSON; Reset restores the default layout.

## Files

- `index.html` – page, sidebar and import map
- `style.css` – styles (sidebar becomes a bottom sheet on phones)
- `main.js` – scene, room geometry, furniture builders, interaction and persistence
- `catalog.js` – furniture catalog (`name, w, d, h` in inches, `color`, optional `url` / `price`) and the default layout.
  Swap this for rows pulled from a Notion database later.
- `screenshots/` – reference renders
