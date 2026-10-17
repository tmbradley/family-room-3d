import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { CATALOG, DEFAULT_LAYOUT } from './catalog.js';

// ---------------------------------------------------------------------------
// Room constants (feet). Room coords: x 0 (fireplace wall) -> 12 (open side),
// z 0 (front wall) -> 13 (back/window wall). World = (x, y, -z) so that in the
// top view the back wall is at the top of the screen and the fireplace on the left.
// ---------------------------------------------------------------------------
const ROOM = { W: 12, D: 13, H: 9, CUT: 3, T: 0.5 };
const FIRE = { z0: 4, z1: 9, boxZ0: 4.75, boxZ1: 8.25, boxH: 2.75, mantelY: 4.5 };
const WIN = { x0: 4, x1: 9, sill: 2.5, top: 7.5 };
const WALKWAY = [{ x0: 12, x1: 15, label: "WALKWAY 3'", color: '#bd7d3b' }, { x0: 15, x1: 17.5, label: "TOWARD KITCHEN / NOOK 2.5'", color: '#b2743a' }];
const STORAGE_KEY = 'familyRoom3d.layout.v1';
const SNAP = 0.25; // 3 inches
const W = (x, z, y = 0) => new THREE.Vector3(x, y, -z);
const catalogById = Object.fromEntries(CATALOG.map(c => [c.id, c]));

// ---------------------------------------------------------------------------
// Renderer / scene / cameras
// ---------------------------------------------------------------------------
const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
viewport.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#ece8e2');

const center = W(ROOM.W / 2, ROOM.D / 2);
const persp = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
persp.position.set(15.5, 15, 9.5);
const ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
ortho.up.set(0, 0, -1);
const planCenter = W(8.0, ROOM.D / 2);
ortho.position.set(planCenter.x, 60, planCenter.z);
ortho.lookAt(planCenter);

const perspControls = new OrbitControls(persp, renderer.domElement);
perspControls.target.copy(center);
perspControls.enableDamping = true;
perspControls.maxPolarAngle = Math.PI / 2 - 0.02;
perspControls.minDistance = 3; perspControls.maxDistance = 60;
perspControls.update();

const orthoControls = new OrbitControls(ortho, renderer.domElement);
orthoControls.target.copy(planCenter);
orthoControls.enableRotate = false;
orthoControls.screenSpacePanning = true;
orthoControls.enabled = false;
orthoControls.update();

let camera = persp, controls = perspControls, viewMode = '3d';

scene.add(new THREE.HemisphereLight('#fff7ea', '#8a6a4a', 1.4));
const sun = new THREE.DirectionalLight('#fff3e0', 1.6);
sun.position.set(10, 20, 6);
sun.target.position.copy(center);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 60 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, ...opts });
function box(w, h, d, material, x = 0, y = 0, z = 0) { // y = bottom; x,z = center (local/world)
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
// world-space box from room-coord extents
function roomBox(x0, x1, y0, y1, z0, z1, material) {
  return box(x1 - x0, y1 - y0, z1 - z0, material, (x0 + x1) / 2, y0, -(z0 + z1) / 2);
}
function textPlane(text, widthFt, { color = '#5a4632', size = 64, bg = null, heightFt } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `600 ${size}px sans-serif`;
  const tw = ctx.measureText(text).width;
  c.width = Math.ceil(tw + size); c.height = Math.ceil(size * 1.5);
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); }
  g.font = `600 ${size}px sans-serif`; g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const h = heightFt ?? widthFt * c.height / c.width;
  const w = heightFt ? heightFt * c.width / c.height : widthFt;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}
const fmtFtIn = ft => {
  const neg = ft < 0; let inches = Math.round(Math.abs(ft) * 12);
  const f = Math.floor(inches / 12), i = inches % 12;
  return (neg ? '−' : '') + (f ? `${f}' ` : '') + `${i}"`;
};

// ---------------------------------------------------------------------------
// Floor
// ---------------------------------------------------------------------------
function plankTexture(base) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 512, 1024);
  const plankW = 512 / 9.6; // ~5" planks on a 4 ft tile
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 10; i++) {
    const x = i * plankW;
    g.fillStyle = `rgba(${rnd() > .5 ? '255,230,190' : '90,50,20'},${0.04 + rnd() * 0.06})`;
    g.fillRect(x, 0, plankW, 1024);
    g.fillStyle = 'rgba(70,40,15,0.28)'; g.fillRect(x, 0, 1.5, 1024);
    const joint = rnd() * 1024; g.fillRect(x, joint, plankW, 1.5);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
const floorGroup = new THREE.Group(); scene.add(floorGroup);
{
  const tex = plankTexture('#c8873f'); tex.repeat.set(ROOM.W / 4, ROOM.D / 8);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.W, ROOM.D), mat('#ffffff', { map: tex, roughness: 0.55 }));
  floor.rotation.x = -Math.PI / 2; floor.position.copy(center); floor.receiveShadow = true;
  floor.name = 'floor'; floorGroup.add(floor);
  for (const s of WALKWAY) {
    const t2 = plankTexture(s.color); t2.repeat.set((s.x1 - s.x0) / 4, ROOM.D / 8);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(s.x1 - s.x0, ROOM.D), mat('#ffffff', { map: t2, roughness: 0.6 }));
    strip.rotation.x = -Math.PI / 2; strip.position.copy(W((s.x0 + s.x1) / 2, ROOM.D / 2, -0.002)); strip.receiveShadow = true;
    floorGroup.add(strip);
    const lbl = textPlane(s.label, ROOM.D * 0.8, { color: 'rgba(60,35,15,0.75)', heightFt: Math.min(0.9, (s.x1 - s.x0) * 0.3) });
    lbl.rotation.z = Math.PI / 2; // reads along the strip
    lbl.position.copy(W((s.x0 + s.x1) / 2, ROOM.D / 2, 0.01)); floorGroup.add(lbl);
  }
  // dashed line marking the open edge of the room at x=12
  const pts = []; for (let z = 0; z < ROOM.D; z += 0.5) { pts.push(W(ROOM.W, z, 0.01), W(ROOM.W, Math.min(z + 0.3, ROOM.D), 0.01)); }
  floorGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#6b4a2a' })));
  // ground beyond
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), mat('#e3ddd4'));
  ground.rotation.x = -Math.PI / 2; ground.position.set(6, -0.02, -6.5); ground.receiveShadow = true; scene.add(ground);
  // dimension labels
  const d1 = textPlane("12' wide (fireplace wall → open side)", 6, { heightFt: 0.55, color: '#5a4632' });
  d1.position.copy(W(6, -1.2, 0.01)); floorGroup.add(d1);
  const d2 = textPlane("13' deep", 3, { heightFt: 0.55, color: '#5a4632' });
  d2.rotation.z = Math.PI / 2; d2.position.copy(W(-1.4, 6.5, 0.01)); floorGroup.add(d2);
  const d3 = textPlane("OPEN — no wall", 3, { heightFt: 0.4, color: 'rgba(60,35,15,0.7)' });
  d3.rotation.z = Math.PI / 2; d3.position.copy(W(11.75, 6.5, 0.012)); floorGroup.add(d3);
}

// ---------------------------------------------------------------------------
// Walls (rebuilt when toggling full / cutaway)
// ---------------------------------------------------------------------------
const wallMat = mat('#d8cfc2', { roughness: 0.9 });
const trimMat = mat('#ffffff', { roughness: 0.5 });
const slateMat = mat('#8f8880', { roughness: 0.85 }); // light stone surround / hearth
const fireboxMat = mat('#0c0b0b', { roughness: 1 });
const glassMat = new THREE.MeshStandardMaterial({ color: '#a9d4f2', transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.1 });
let wallsGroup = null, fullWalls = false, wallSets = null;

// Builds one set of walls at height H, split into { left, front, back, misc } groups.
function buildWallSet(H) {
  const T = ROOM.T, set = { left: new THREE.Group(), front: new THREE.Group(), back: new THREE.Group(), misc: new THREE.Group() };
  const to = grp => (...a) => grp.add(roomBox(...a));
  let add = to(set.left);
  // Left wall x in [-T, 0], z in [-T, D+T], with the flush fireplace opening cut into it
  add(-T, 0, 0, H, -T, FIRE.boxZ0, wallMat);
  add(-T, 0, 0, H, FIRE.boxZ1, ROOM.D + T, wallMat);
  if (H > FIRE.boxH) add(-T, 0, FIRE.boxH, H, FIRE.boxZ0, FIRE.boxZ1, wallMat);
  // firebox: dark recess inside the wall thickness (flush, nothing sticks into the room)
  add(-T + 0.02, -0.03, 0, Math.min(FIRE.boxH, H) - 0.001, FIRE.boxZ0, FIRE.boxZ1, fireboxMat);
  // flush stone surround, 5' wide (z 4..9), a hair proud of the wall face so it is visible
  const sTop = Math.min(FIRE.mantelY, H);
  add(0, 0.01, 0, sTop, FIRE.z0, FIRE.boxZ0, slateMat);
  add(0, 0.01, 0, sTop, FIRE.boxZ1, FIRE.z1, slateMat);
  if (sTop > FIRE.boxH) add(0, 0.01, FIRE.boxH, sTop, FIRE.boxZ0, FIRE.boxZ1, slateMat);
  if (H > FIRE.mantelY) add(0, 0.12, FIRE.mantelY, FIRE.mantelY + 0.12, FIRE.z0 - 0.15, FIRE.z1 + 0.15, trimMat); // thin mantel line
  add(0, bbT, 0, bbH, 0, FIRE.z0, trimMat); add(0, bbT, 0, bbH, FIRE.z1, ROOM.D, trimMat); // baseboards

  // Front wall (z in [-T, 0]) — solid, no openings
  add = to(set.front);
  add(-T, ROOM.W, 0, H, -T, 0, wallMat);
  add(0, ROOM.W, 0, bbH, -0.001, bbT, trimMat);
  add(ROOM.W - 0.001, ROOM.W + 0.02, 0, H, -T, 0, trimMat); // finished wall end at the open side

  // Back wall (z in [D, D+T]) with the 5' window from x=4 to x=9
  add = to(set.back);
  add(-T, WIN.x0, 0, H, ROOM.D, ROOM.D + T, wallMat);
  add(WIN.x1, ROOM.W, 0, H, ROOM.D, ROOM.D + T, wallMat);
  add(WIN.x0, WIN.x1, 0, Math.min(WIN.sill, H), ROOM.D, ROOM.D + T, wallMat);
  if (H > WIN.top) add(WIN.x0, WIN.x1, WIN.top, H, ROOM.D, ROOM.D + T, wallMat);
  const gTop = Math.min(WIN.top, H), f = 0.25;
  if (H > WIN.sill) {
    add(WIN.x0 + f, WIN.x1 - f, WIN.sill, gTop - (H > WIN.top ? f : 0), ROOM.D + 0.17, ROOM.D + 0.33, glassMat);
    add(WIN.x0, WIN.x0 + f, WIN.sill, gTop, ROOM.D - 0.03, ROOM.D + T, trimMat);
    add(WIN.x1 - f, WIN.x1, WIN.sill, gTop, ROOM.D - 0.03, ROOM.D + T, trimMat);
    if (H > WIN.top) add(WIN.x0, WIN.x1, WIN.top - f, WIN.top, ROOM.D - 0.03, ROOM.D + T, trimMat);
    if (H > WIN.top) add(WIN.x0 + f, WIN.x1 - f, (WIN.sill + WIN.top) / 2 - 0.04, (WIN.sill + WIN.top) / 2 + 0.04, ROOM.D + 0.2, ROOM.D + 0.3, trimMat);
  }
  add(WIN.x0 - 0.1, WIN.x1 + 0.1, WIN.sill - 0.12, WIN.sill, ROOM.D - 0.15, ROOM.D + T, trimMat); // sill
  if (H < WIN.top) add(WIN.x0 + f, WIN.x1 - f, H, H + 0.005, ROOM.D + 0.05, ROOM.D + T - 0.05, new THREE.MeshBasicMaterial({ color: '#7fb9e6' })); // plan-view window mark
  add(0, ROOM.W, 0, bbH, ROOM.D - bbT, ROOM.D + 0.001, trimMat);
  add(ROOM.W - 0.001, ROOM.W + 0.02, 0, H, ROOM.D, ROOM.D + T, trimMat);
  for (const k of ['left', 'front', 'back']) set[k].traverse(o => { if (o.isMesh) o.userData.static = true; });
  return set;
}
const bbH = 0.33, bbT = 0.05;

function buildWalls() {
  if (!wallsGroup) {
    wallsGroup = new THREE.Group(); scene.add(wallsGroup);
    wallSets = { full: buildWallSet(ROOM.H), cut: buildWallSet(ROOM.CUT) };
    for (const set of Object.values(wallSets)) for (const k of ['left', 'front', 'back']) wallsGroup.add(set[k]);
    // flush hearth + floor label (shared)
    wallsGroup.add(roomBox(0, 1.3, 0.001, 0.012, FIRE.z0, FIRE.z1, slateMat));
    const fl = textPlane('FIREPLACE (flush)', 4, { heightFt: 0.38, color: '#2b2622' });
    fl.rotation.z = Math.PI / 2; fl.position.copy(W(0.65, (FIRE.z0 + FIRE.z1) / 2, 0.02)); wallsGroup.add(fl);
  }
  updateWallVisibility();
  document.getElementById('btnWalls').textContent = fullWalls ? "Walls: full (9') – near walls auto-cut" : "Walls: cutaway (3')";
}
// In full-wall mode, walls between the camera and the room drop to cutaway height (dollhouse view).
function updateWallVisibility() {
  if (!wallSets) return;
  const c = camera.position, top = viewMode === 'top';
  const near = { left: !top && c.x < 0, front: !top && c.z > 0, back: !top && c.z < -ROOM.D };
  for (const k of ['left', 'front', 'back']) {
    const full = fullWalls && !near[k];
    wallSets.full[k].visible = full; wallSets.cut[k].visible = !full;
  }
}

// ---------------------------------------------------------------------------
// Furniture builders. Local frame: centered footprint, y=0 on floor, front faces +Z.
// All dimensions passed in feet.
// ---------------------------------------------------------------------------
function taperedLeg(h, material, x, z) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.03, h, 10), material);
  m.position.set(x, h / 2, z); m.castShadow = true; return m;
}
function legs4(g, w, d, h, material, inset = 0.2) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(taperedLeg(h, material, sx * (w / 2 - inset), sz * (d / 2 - inset)));
}
const BUILDERS = {
  sofa(g, w, d, h, it) {
    const fab = mat(it.color, { roughness: 0.95 }), wood = mat(it.legColor || '#5a3a22', { roughness: 0.6 });
    const legH = 0.5, arm = 0.45, backD = 0.65;
    legs4(g, w, d, legH, wood, 0.3);
    g.add(box(w, 0.45, d, fab, 0, legH, 0));
    g.add(box(w, h - legH - 0.45, backD, fab, 0, legH + 0.45, -d / 2 + backD / 2));
    for (const s of [-1, 1]) g.add(box(arm, 1.05, d, fab, s * (w / 2 - arm / 2), legH + 0.45, 0));
    const cw = (w - 2 * arm) / 2, cd = d - backD;
    for (const s of [-1, 1]) g.add(box(cw - 0.04, 0.38, cd - 0.05, mat(it.color, { roughness: 1 }), s * cw / 2, legH + 0.45, d / 2 - cd / 2));
  },
  chair(g, w, d, h, it) {
    const lea = mat(it.color, { roughness: 0.45 }), wood = mat(it.legColor || '#5a3a22', { roughness: 0.6 });
    const legH = 0.55;
    legs4(g, w, d, legH, wood, 0.18);
    g.add(box(w - 0.3, 0.12, d - 0.1, wood, 0, legH, 0));
    g.add(box(w - 0.4, 0.42, d * 0.78, lea, 0, legH + 0.12, d * 0.1));
    const back = box(w - 0.4, h - legH - 0.2, 0.4, lea, 0, 0, 0);
    const pivot = new THREE.Group(); pivot.position.set(0, legH + 0.2, -d / 2 + 0.35); pivot.rotation.x = -0.22; pivot.add(back); g.add(pivot);
    for (const s of [-1, 1]) {
      g.add(box(0.14, 0.1, d - 0.2, wood, s * (w / 2 - 0.12), 1.75, 0.05));
      g.add(box(0.1, 1.75 - legH, 0.1, wood, s * (w / 2 - 0.12), legH, d / 2 - 0.25));
    }
  },
  coffeeTable(g, w, d, h, it) {
    const wood = mat(it.color, { roughness: 0.5 });
    legs4(g, w, d, h - 0.12, wood, 0.25);
    g.add(box(w, 0.12, d, wood, 0, h - 0.12, 0));
    g.add(box(w - 0.6, 0.06, d - 0.4, wood, 0, 0.45, 0));
  },
  rug(g, w, d, h, it) {
    const c = document.createElement('canvas'); c.width = 512; c.height = Math.round(512 * d / w);
    const x = c.getContext('2d');
    x.fillStyle = it.color; x.fillRect(0, 0, c.width, c.height);
    x.strokeStyle = it.accent || '#a8622f'; x.lineWidth = 14; x.strokeRect(22, 22, c.width - 44, c.height - 44);
    x.lineWidth = 5; x.strokeRect(46, 46, c.width - 92, c.height - 92);
    x.fillStyle = it.accent || '#a8622f'; x.globalAlpha = 0.55;
    const s = 64;
    for (let yy = 90; yy < c.height - 110; yy += s) for (let xx = 90; xx < c.width - 110; xx += s) {
      x.beginPath(); x.moveTo(xx + s / 2, yy + 8); x.lineTo(xx + s - 8, yy + s / 2); x.lineTo(xx + s / 2, yy + s - 8); x.lineTo(xx + 8, yy + s / 2); x.closePath();
      ((xx + yy) / s) % 2 ? x.fill() : (x.lineWidth = 4, x.stroke());
    }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const m = box(w, 0.04, d, [mat(it.color), mat(it.color), mat('#ffffff', { map: tex, roughness: 1 }), mat(it.color), mat(it.color), mat(it.color)], 0, 0.003, 0);
    m.castShadow = false; g.add(m);
  },
  console(g, w, d, h, it) {
    const wood = mat(it.color, { roughness: 0.55 }), dark = mat('#3d2716', { roughness: 0.6 });
    const legH = 0.45;
    legs4(g, w, d, legH, wood, 0.2);
    g.add(box(w, h - legH, d, wood, 0, legH, 0));
    for (let i = 1; i < 3; i++) g.add(box(0.03, h - legH - 0.2, 0.02, dark, -w / 2 + i * w / 3, legH + 0.1, d / 2 + 0.005));
    const tvW = (it.tv?.w ?? 57) / 12, tvH = (it.tv?.h ?? 33) / 12;
    const black = mat('#111111', { roughness: 0.3 });
    g.add(box(0.8, 0.05, 0.5, black, 0, h, -0.05));
    g.add(box(0.15, 0.25, 0.08, black, 0, h, -0.1));
    g.add(box(tvW, tvH, 0.12, black, 0, h + 0.22, -0.1));
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(tvW - 0.1, tvH - 0.1), new THREE.MeshStandardMaterial({ color: '#1b2633', roughness: 0.15, metalness: 0.3 }));
    scr.position.set(0, h + 0.22 + tvH / 2, -0.039); g.add(scr);
  },
  lamp(g, w, d, h, it) {
    const brass = mat(it.color, { metalness: 0.8, roughness: 0.3 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(w / 2 * 0.85, w / 2, 0.08, 24), brass); base.position.y = 0.04; base.castShadow = true; g.add(base);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, h - 0.9, 8), brass); pole.position.y = (h - 0.9) / 2; pole.castShadow = true; g.add(pole);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(w / 2 * 0.8, w / 2, 0.9, 24, 1, true), mat('#f4ead8', { side: THREE.DoubleSide, emissive: '#5a4a30', emissiveIntensity: 0.4 }));
    shade.position.y = h - 0.45; shade.castShadow = true; g.add(shade);
  },
  box(g, w, d, h, it) { g.add(box(w, h, d, mat(it.color), 0, 0, 0)); },
};

// ---------------------------------------------------------------------------
// Layout state
// ---------------------------------------------------------------------------
let items = [];            // { uid, type, kind, name, w, d, h (in), color, ..., x, z (ft), rot (deg) }
const objects = new Map(); // uid -> THREE.Group
let selected = null, uidSeq = 1;
const furnitureRoot = new THREE.Group(); scene.add(furnitureRoot);
let selHelper = null;

const footprint = it => { const r = ((it.rot % 360) + 360) % 360; const sw = (r === 90 || r === 270); const w = (sw ? it.d : it.w) / 12, d = (sw ? it.w : it.d) / 12; return { w, d, x0: it.x - w / 2, x1: it.x + w / 2, z0: it.z - d / 2, z1: it.z + d / 2 }; };

function makeItem(type, overrides = {}) {
  const base = type === 'custom' ? { kind: 'box' } : { ...catalogById[type] };
  return { ...base, ...overrides, type, uid: overrides.uid ?? `i${uidSeq++}`, kind: base.kind ?? overrides.kind ?? 'box' };
}
function buildObject(it) {
  const g = new THREE.Group();
  (BUILDERS[it.kind] || BUILDERS.box)(g, it.w / 12, it.d / 12, it.h / 12, it);
  g.traverse(o => { o.userData.uid = it.uid; });
  const div = document.createElement('div'); div.className = 'lbl'; div.textContent = it.name;
  const lbl = new CSS2DObject(div); lbl.position.set(0, Math.max(it.h / 12, 0.3) + 0.35, it.kind === 'rug' ? it.d / 24 - 1 : 0); g.add(lbl);
  g.userData.labelEl = div;
  return g;
}
function placeObject(it) {
  const g = objects.get(it.uid);
  g.position.copy(W(it.x, it.z));
  g.rotation.y = THREE.MathUtils.degToRad(it.rot);
  if (selHelper && selected === it.uid) selHelper.update();
}
function addItem(it, { select = false, save = true } = {}) {
  items.push(it);
  const g = buildObject(it); objects.set(it.uid, g); furnitureRoot.add(g); placeObject(it);
  if (select) selectItem(it.uid);
  if (save) persist();
}
function removeItem(uid) {
  const g = objects.get(uid); if (!g) return;
  g.traverse(o => { if (o.isCSS2DObject) o.element.remove(); });
  furnitureRoot.remove(g); objects.delete(uid);
  items = items.filter(i => i.uid !== uid);
  if (selected === uid) selectItem(null);
  persist();
}
function clearAll() { for (const uid of [...objects.keys()]) { const g = objects.get(uid); g.traverse(o => { if (o.isCSS2DObject) o.element.remove(); }); furnitureRoot.remove(g); } objects.clear(); items = []; selectItem(null); }

function snapItem(it) {
  if (!snapOn) return;
  const f = footprint(it);
  it.x = Math.round(f.x0 / SNAP) * SNAP + f.w / 2;
  it.z = Math.round(f.z0 / SNAP) * SNAP + f.d / 2;
}
function clampItem(it) {
  const f = footprint(it);
  it.x = THREE.MathUtils.clamp(it.x, f.w / 2, 17.5 - f.w / 2);
  it.z = THREE.MathUtils.clamp(it.z, f.d / 2, ROOM.D - f.d / 2);
}

// ---------------------------------------------------------------------------
// Selection + info panel
// ---------------------------------------------------------------------------
const selInfo = document.getElementById('selInfo');
const btnRotate = document.getElementById('btnRotate'), btnDelete = document.getElementById('btnDelete');
function selectItem(uid) {
  if (selected && objects.get(selected)) objects.get(selected).userData.labelEl.classList.remove('sel');
  if (selHelper) { scene.remove(selHelper); selHelper.geometry.dispose(); selHelper = null; }
  selected = uid;
  const g = uid && objects.get(uid);
  if (g) { selHelper = new THREE.BoxHelper(g, '#ffb400'); scene.add(selHelper); g.userData.labelEl.classList.add('sel'); }
  btnRotate.disabled = btnDelete.disabled = !g;
  updateInfo();
}
function updateInfo() {
  const it = items.find(i => i.uid === selected);
  if (!it) { selInfo.innerHTML = 'Tap a piece to select it. Drag to move.'; return; }
  const f = footprint(it);
  const walls = [
    { name: 'left (fireplace) wall', v: f.x0 },
    { name: 'front wall', v: f.z0 },
    { name: 'back (window) wall', v: ROOM.D - f.z1 },
  ];
  const near = walls.reduce((a, b) => (b.v < a.v ? b : a));
  const openEdge = ROOM.W - f.x1;
  const inch = n => `${+n.toFixed(1)}"`;
  selInfo.innerHTML = `<b>${escapeHtml(it.name)}</b><br>
    ${inch(it.w)} W × ${inch(it.d)} D × ${inch(it.h)} H<br>
    Footprint now: ${fmtFtIn(f.w)} × ${fmtFtIn(f.d)} · rotated ${it.rot}°<br>
    Nearest wall: <b>${fmtFtIn(near.v)}</b> to the ${near.name}<br>
    <span class="small">Left ${fmtFtIn(walls[0].v)} · Front ${fmtFtIn(walls[1].v)} · Back ${fmtFtIn(walls[2].v)} · Open edge ${openEdge >= 0 ? fmtFtIn(openEdge) : 'past it by ' + fmtFtIn(-openEdge)}</span>`;
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function rotateSelected() {
  const it = items.find(i => i.uid === selected); if (!it) return;
  it.rot = (it.rot + 90) % 360; snapItem(it); clampItem(it); placeObject(it); updateInfo(); persist();
}

// ---------------------------------------------------------------------------
// Pointer: pick + drag on the floor plane
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let drag = null, downPos = null;
function setNdc(e) { const r = renderer.domElement.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); raycaster.setFromCamera(ndc, camera); }
function floorHit() { const p = new THREE.Vector3(); return raycaster.ray.intersectPlane(floorPlane, p) ? { x: p.x, z: -p.z } : null; }
renderer.domElement.addEventListener('pointerdown', e => {
  if (e.button !== undefined && e.button !== 0) return;
  setNdc(e); downPos = { x: e.clientX, y: e.clientY };
  const hits = raycaster.intersectObjects(furnitureRoot.children, true).filter(h => h.object.userData.uid && h.object.isMesh);
  if (!hits.length) return;
  const uid = hits[0].object.userData.uid; selectItem(uid);
  const it = items.find(i => i.uid === uid), p = floorHit(); if (!p) return;
  drag = { it, dx: it.x - p.x, dz: it.z - p.z, id: e.pointerId, moved: false };
  controls.enabled = false;
  renderer.domElement.setPointerCapture(e.pointerId);
}, { capture: true });
renderer.domElement.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  setNdc(e); const p = floorHit(); if (!p) return;
  drag.it.x = p.x + drag.dx; drag.it.z = p.z + drag.dz; drag.moved = true;
  snapItem(drag.it); clampItem(drag.it); placeObject(drag.it); updateInfo();
});
function endDrag(e) {
  if (drag) { if (drag.moved) persist(); drag = null; controls.enabled = true; return; }
  if (downPos && e && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) < 5) {
    setNdc(e);
    const hits = raycaster.intersectObjects(furnitureRoot.children, true).filter(h => h.object.userData.uid);
    if (!hits.length) selectItem(null);
  }
  downPos = null;
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', () => { drag = null; controls.enabled = true; });

window.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'r' || e.key === 'R') rotateSelected();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); removeItem(selected); }
  else if (e.key === 'Escape') selectItem(null);
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function fitOrtho() {
  const r = viewport.getBoundingClientRect(), aspect = r.width / Math.max(r.height, 1);
  const needW = 21, needH = 17; // feet of plan to show (room + walkway + labels)
  let halfH = needH / 2, halfW = halfH * aspect;
  if (halfW < needW / 2) { halfW = needW / 2; halfH = halfW / aspect; }
  Object.assign(ortho, { left: -halfW, right: halfW, top: halfH, bottom: -halfH }); ortho.updateProjectionMatrix();
}
function setView(mode) {
  viewMode = mode;
  controls.enabled = false;
  if (mode === 'top') { camera = ortho; controls = orthoControls; fitOrtho(); ortho.zoom = 1; ortho.position.set(planCenter.x, 60, planCenter.z); orthoControls.target.copy(planCenter); ortho.updateProjectionMatrix(); }
  else { camera = persp; controls = perspControls; }
  sun.castShadow = mode !== 'top';
  controls.enabled = true; controls.update();
  document.getElementById('btn3d').classList.toggle('active', mode === '3d');
  document.getElementById('btnTop').classList.toggle('active', mode === 'top');
}
function resize() {
  const r = viewport.getBoundingClientRect();
  renderer.setSize(r.width, r.height); labelRenderer.setSize(r.width, r.height);
  persp.aspect = r.width / Math.max(r.height, 1); persp.updateProjectionMatrix();
  fitOrtho();
}
new ResizeObserver(resize).observe(viewport);

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
let snapOn = true;
const saveStatus = document.getElementById('saveStatus');
const serialize = () => ({ version: 1, room: { widthFt: ROOM.W, depthFt: ROOM.D, ceilingFt: ROOM.H }, settings: { snap: snapOn, fullWalls },
  items: items.map(({ uid, ...rest }) => rest) });
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize())); saveStatus.textContent = `Saved ${new Date().toLocaleTimeString()}`; } catch (err) { saveStatus.textContent = 'Could not save: ' + err.message; }
}
function loadLayout(data) {
  if (!data || !Array.isArray(data.items)) throw new Error('Invalid layout file: no items array');
  clearAll();
  for (const raw of data.items) {
    const it = makeItem(raw.type || 'custom', { ...raw, uid: undefined });
    for (const k of ['w', 'd', 'h', 'x', 'z', 'rot']) it[k] = Number(it[k]) || 0;
    addItem(it, { save: false });
  }
  if (data.settings) { snapOn = data.settings.snap !== false; fullWalls = !!data.settings.fullWalls; document.getElementById('snapToggle').checked = snapOn; buildWalls(); }
  persist();
}
function defaultLayout() { return { version: 1, settings: { snap: true, fullWalls: false }, items: DEFAULT_LAYOUT.map(l => ({ ...catalogById[l.type], ...l })) }; }

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
const catalogList = document.getElementById('catalogList');
for (const c of CATALOG) {
  const b = document.createElement('button');
  b.innerHTML = `${escapeHtml(c.name)}<small>${c.w}" × ${c.d}"${c.kind === 'rug' ? '' : ` × ${c.h}"`}${c.price ? ' · $' + c.price : ''}</small>`;
  b.onclick = () => addNew(makeItem(c.id));
  catalogList.appendChild(b);
}
function addNew(it) {
  it.x = ROOM.W / 2; it.z = ROOM.D / 2; it.rot = 0; snapItem(it); clampItem(it);
  addItem(it, { select: true });
}
document.getElementById('customForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = id => document.getElementById(id).value;
  const it = makeItem('custom', { name: v('cName').trim() || 'Custom box', w: +v('cW'), d: +v('cD'), h: +v('cH'), color: v('cColor') });
  if (!(it.w > 0 && it.d > 0 && it.h > 0)) return;
  addNew(it);
});
btnRotate.onclick = rotateSelected;
btnDelete.onclick = () => selected && removeItem(selected);
document.getElementById('btn3d').onclick = () => setView('3d');
document.getElementById('btnTop').onclick = () => setView('top');
document.getElementById('btnWalls').onclick = () => { fullWalls = !fullWalls; buildWalls(); persist(); };
document.getElementById('snapToggle').onchange = e => { snapOn = e.target.checked; persist(); };
document.getElementById('labelToggle').onchange = e => viewport.classList.toggle('hide-labels', !e.target.checked);
document.getElementById('btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'family-room-layout.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
const importFile = document.getElementById('importFile');
document.getElementById('btnImport').onclick = () => importFile.click();
importFile.onchange = async () => {
  const f = importFile.files[0]; if (!f) return;
  try { loadLayout(JSON.parse(await f.text())); } catch (err) { alert('Import failed: ' + err.message); }
  importFile.value = '';
};
document.getElementById('btnReset').onclick = () => { if (confirm('Reset to the default layout? Your current layout will be replaced.')) loadLayout(defaultLayout()); };
document.getElementById('toggleSidebar').onclick = () => document.getElementById('sidebar').classList.toggle('collapsed');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
buildWalls();
let saved = null;
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { saved = null; }
try { loadLayout(saved || defaultLayout()); } catch { loadLayout(defaultLayout()); }
const params = new URLSearchParams(location.search);
resize();
setView(params.get('view') === 'top' ? 'top' : '3d');

renderer.setAnimationLoop(() => {
  controls.update();
  updateWallVisibility();
  if (selHelper) selHelper.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

// expose for debugging / tests
window.familyRoom = { items: () => items, select: selectItem, setView, rotateSelected, removeItem, footprint, serialize };
window.familyRoom._project = (x, z) => { const v = W(x, z, 0.5).project(camera); const r = renderer.domElement.getBoundingClientRect(); return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; };
window.familyRoom._scene = scene;
