// RoomView: one 3D/top view of a workspace's rooms, built from API data (inches).
// Room coords: x = xIn/12 ft, z = yIn/12 ft. World = (x, y, -z) so the back wall is at the top in top view.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const CUT = 3;            // cutaway wall height (ft)
const SNAP_FT = 0.25;     // 3"
const W = (x, z, y = 0) => new THREE.Vector3(x, y, -z);
const ft = (inches) => inches / 12;
const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, ...opts });
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w, 0.001), Math.max(h, 0.001), Math.max(d, 0.001)), material);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function textPlane(text, { color = '#5a4632', size = 64, heightFt = 0.5 } = {}) {
  const c = document.createElement('canvas');
  const g0 = c.getContext('2d'); g0.font = `600 ${size}px sans-serif`;
  c.width = Math.ceil(g0.measureText(text).width + size); c.height = Math.ceil(size * 1.5);
  const g = c.getContext('2d');
  g.font = `600 ${size}px sans-serif`; g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(heightFt * c.width / c.height, heightFt), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}
function plankTexture(base) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 512, 1024);
  const plankW = 512 / 9.6;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 10; i++) {
    const x = i * plankW;
    g.fillStyle = `rgba(${rnd() > .5 ? '255,230,190' : '90,50,20'},${0.04 + rnd() * 0.06})`; g.fillRect(x, 0, plankW, 1024);
    g.fillStyle = 'rgba(70,40,15,0.28)'; g.fillRect(x, 0, 1.5, 1024); g.fillRect(x, rnd() * 1024, plankW, 1.5);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------------------
// Furniture builders. Local frame: centered footprint, y = 0 on floor, front faces +Z. Sizes in feet.
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
  sectional(g, w, d, h, it) {
    // L-shape: a long run across the back (w) and a chaise down the right side (d).
    const fab = mat(it.color, { roughness: 0.95 }), cush = mat(it.color, { roughness: 1 });
    const sd = Math.min(3, d * 0.45), backD = 0.7, base = 1.3, arm = 0.45;
    g.add(box(w, base, sd, fab, 0, 0, -d / 2 + sd / 2));
    g.add(box(sd, base, d - sd, fab, w / 2 - sd / 2, 0, sd / 2));
    g.add(box(w, h - base, backD, fab, 0, base, -d / 2 + backD / 2));
    g.add(box(arm, 0.9, sd, fab, -w / 2 + arm / 2, base, -d / 2 + sd / 2));
    g.add(box(sd, 0.9, arm, fab, w / 2 - sd / 2, base, d / 2 - arm / 2));
    const n = 3, cw = (w - sd - arm) / n;
    for (let i = 0; i < n; i++) g.add(box(cw - 0.06, 0.35, sd - backD - 0.05, cush, -w / 2 + arm + cw * (i + 0.5), base, -d / 2 + backD + (sd - backD) / 2));
    g.add(box(sd - backD - 0.05, 0.35, d - sd - arm - 0.05, cush, w / 2 - sd / 2 + backD / 2, base, sd / 2 - arm / 2));
  },
  chair(g, w, d, h, it) {
    const lea = mat(it.color, { roughness: 0.45 }), wood = mat(it.legColor || '#5a3a22', { roughness: 0.6 });
    const legH = 0.55;
    legs4(g, w, d, legH, wood, 0.18);
    g.add(box(w - 0.3, 0.12, d - 0.1, wood, 0, legH, 0));
    g.add(box(w - 0.4, 0.42, d * 0.78, lea, 0, legH + 0.12, d * 0.1));
    const back = box(w - 0.4, Math.max(h - legH - 0.2, 0.3), 0.4, lea, 0, 0, 0);
    const pivot = new THREE.Group(); pivot.position.set(0, legH + 0.2, -d / 2 + 0.35); pivot.rotation.x = -0.22; pivot.add(back); g.add(pivot);
  },
  coffeeTable(g, w, d, h, it) {
    const wood = mat(it.color, { roughness: 0.5 });
    legs4(g, w, d, h - 0.12, wood, 0.25);
    g.add(box(w, 0.12, d, wood, 0, h - 0.12, 0));
    g.add(box(w - 0.6, 0.06, d - 0.4, wood, 0, 0.45, 0));
  },
  rug(g, w, d, h, it) {
    const c = document.createElement('canvas'); c.width = 512; c.height = Math.max(64, Math.round(512 * d / w));
    const x = c.getContext('2d');
    const accent = it.accentColor || it.accent || '#a8622f';
    x.fillStyle = it.color || '#efe6d6'; x.fillRect(0, 0, c.width, c.height);
    x.strokeStyle = accent; x.lineWidth = 14; x.strokeRect(22, 22, c.width - 44, c.height - 44);
    x.lineWidth = 5; x.strokeRect(46, 46, c.width - 92, c.height - 92);
    x.fillStyle = accent; x.globalAlpha = 0.55;
    const s = 64;
    for (let yy = 90; yy < c.height - 110; yy += s) for (let xx = 90; xx < c.width - 110; xx += s) {
      x.beginPath(); x.moveTo(xx + s / 2, yy + 8); x.lineTo(xx + s - 8, yy + s / 2); x.lineTo(xx + s / 2, yy + s - 8); x.lineTo(xx + 8, yy + s / 2); x.closePath();
      ((xx + yy) / s) % 2 ? x.fill() : (x.lineWidth = 4, x.stroke());
    }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const side = mat(it.color || '#efe6d6');
    const m = box(w, 0.04, d, [side, side, mat('#ffffff', { map: tex, roughness: 1 }), side, side, side], 0, 0.003, 0);
    m.castShadow = false; g.add(m);
  },
  console(g, w, d, h, it) {
    const wood = mat(it.color, { roughness: 0.55 }), dark = mat('#3d2716', { roughness: 0.6 });
    const legH = 0.45;
    legs4(g, w, d, legH, wood, 0.2);
    g.add(box(w, h - legH, d, wood, 0, legH, 0));
    for (let i = 1; i < 3; i++) g.add(box(0.03, h - legH - 0.2, 0.02, dark, -w / 2 + i * w / 3, legH + 0.1, d / 2 + 0.005));
  },
  tv(g, w, d, h, it) {
    // Wall-mounted screens. A tall item (h > 45") is drawn as two stacked TVs.
    const black = mat('#111111', { roughness: 0.3 }), screen = new THREE.MeshStandardMaterial({ color: '#1b2633', roughness: 0.15, metalness: 0.3 });
    const n = h > 45 / 12 ? 2 : 1, gap = 0.15, ph = (h - gap * (n - 1)) / n, y0 = 2;
    for (let i = 0; i < n; i++) {
      const y = y0 + i * (ph + gap);
      g.add(box(w, ph, Math.max(d, 0.1), black, 0, y, 0));
      const s = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.1, ph - 0.1), screen);
      s.position.set(0, y + ph / 2, Math.max(d, 0.1) / 2 + 0.003); g.add(s);
    }
  },
  lamp(g, w, d, h, it) {
    const brass = mat(it.color, { metalness: 0.8, roughness: 0.3 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(w / 2 * 0.85, w / 2, 0.08, 24), brass); base.position.y = 0.04; g.add(base);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, h - 0.9, 8), brass); pole.position.y = (h - 0.9) / 2; pole.castShadow = true; g.add(pole);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(w / 2 * 0.8, w / 2, 0.9, 24, 1, true), mat('#f4ead8', { side: THREE.DoubleSide, emissive: '#5a4a30', emissiveIntensity: 0.4 }));
    shade.position.y = h - 0.45; g.add(shade);
  },
  box(g, w, d, h, it) { g.add(box(w, h, d, mat(it.color || '#8a7d70'), 0, 0, 0)); },
};

export const footprintFt = (p) => {
  const r = ((p.rotationDeg % 360) + 360) % 360, sw = r === 90 || r === 270;
  const w = ft(sw ? p.item.dIn : p.item.wIn), d = ft(sw ? p.item.wIn : p.item.dIn);
  const x = ft(p.xIn), z = ft(p.yIn);
  return { w, d, x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 };
};

// ---------------------------------------------------------------------------
export class RoomView {
  constructor(container, handlers = {}) {
    this.el = container;
    this.h = handlers;
    this.mode = '3d'; this.walls = 'cut'; this.snap = true; this.editable = false;
    this.data = null; this.selected = null; this.highlight = new Set();
    this.objects = new Map(); this.wallSets = [];

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#ece8e2');
    this.persp = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    this.ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200); this.ortho.up.set(0, 0, -1);
    this.pc = new OrbitControls(this.persp, this.renderer.domElement);
    Object.assign(this.pc, { enableDamping: true, maxPolarAngle: Math.PI / 2 - 0.02, minDistance: 3, maxDistance: 80 });
    this.oc = new OrbitControls(this.ortho, this.renderer.domElement);
    Object.assign(this.oc, { enableRotate: false, screenSpacePanning: true, enabled: false, enableDamping: true });
    this.camera = this.persp; this.controls = this.pc;
    for (const c of [this.pc, this.oc]) c.addEventListener('change', () => { if (this.userDriving) this.h.onCamera?.(this); });

    this.scene.add(new THREE.HemisphereLight('#fff7ea', '#8a6a4a', 1.4));
    this.sun = new THREE.DirectionalLight('#fff3e0', 1.6); this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), mat('#e3ddd4'));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true; this.scene.add(ground);
    this.roomRoot = new THREE.Group(); this.furnRoot = new THREE.Group(); this.scene.add(this.roomRoot, this.furnRoot);

    this.raycaster = new THREE.Raycaster(); this.ndc = new THREE.Vector2();
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.updateWallVisibility();
      if (this.selHelper) this.selHelper.update();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    });
  }

  // ---- data -----------------------------------------------------------------
  setData(ws, { editable = false, highlight = [] } = {}) {
    const first = !this.data;
    this.data = ws; this.editable = editable; this.highlight = new Set(highlight);
    this.buildRooms();
    this.buildFurniture();
    if (first || this.boundsKey !== this.lastFitKey) { this.fit(); this.lastFitKey = this.boundsKey; }
    if (this.selected && !this.placement(this.selected)) this.select(null);
    else this.select(this.selected);
  }
  placement(id) {
    for (const r of this.data?.rooms ?? []) { const p = r.furniture.find((f) => f.id === id); if (p) return p; }
    return null;
  }
  roomOf(p) { return this.data.rooms.find((r) => r.id === p.roomId); }

  clearGroup(g) {
    g.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); });
    for (const c of [...g.children]) g.remove(c);
  }

  buildRooms() {
    this.clearGroup(this.roomRoot); this.wallSets = [];
    const rooms = this.data?.rooms ?? [];
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const r of rooms) for (const w of r.walls) for (const [x, y] of [[w.startXIn, w.startYIn], [w.endXIn, w.endYIn]]) {
      const X = ft(r.originXIn + x), Z = ft(r.originYIn + y);
      minX = Math.min(minX, X); maxX = Math.max(maxX, X); minZ = Math.min(minZ, Z); maxZ = Math.max(maxZ, Z);
    }
    if (!rooms.length || !isFinite(minX)) { minX = 0; minZ = 0; maxX = 12; maxZ = 12; }
    this.bounds = { minX, minZ, maxX, maxZ };
    this.boundsKey = [minX, minZ, maxX, maxZ].join(',');
    for (const r of rooms) this.buildRoom(r);
    if (!rooms.length) {
      const t = textPlane('No rooms yet', { heightFt: 0.9, color: 'rgba(60,35,15,0.6)' });
      t.position.copy(W(6, 6, 0.01)); this.roomRoot.add(t);
    }
    const c = W((minX + maxX) / 2, (minZ + maxZ) / 2);
    const s = Math.max(maxX - minX, maxZ - minZ, 8);
    this.sun.position.set(c.x + s * 0.8, s * 1.6, c.z + s * 0.5); this.sun.target.position.copy(c);
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: s * 5 });
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  buildRoom(r) {
    const ox = ft(r.originXIn), oz = ft(r.originYIn);
    const pts = r.walls.flatMap((w) => [[ox + ft(w.startXIn), oz + ft(w.startYIn)], [ox + ft(w.endXIn), oz + ft(w.endYIn)]]);
    const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, H = ft(r.ceilingIn);
    const floorColor = r.floor?.color || '#c8873f';
    const tex = plankTexture(floorColor); tex.repeat.set((x1 - x0) / 4, (z1 - z0) / 8);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), mat('#ffffff', { map: tex, roughness: 0.55 }));
    floor.rotation.x = -Math.PI / 2; floor.position.copy(W(cx, cz)); floor.receiveShadow = true; this.roomRoot.add(floor);
    const label = textPlane(`${r.label} · ${Math.round(x1 - x0)}' × ${Math.round(z1 - z0)}'`, { heightFt: 0.5 });
    label.position.copy(W(cx, z0 - 1.1, 0.01)); this.roomRoot.add(label);

    const wallMat = mat(r.wallColor?.color || '#d8cfc2', { roughness: 0.9 });
    const trim = mat(r.trimColor?.color || '#ffffff', { roughness: 0.5 });
    const ctx = { cx, cz, H, wallMat, trim };
    for (const w of r.walls) {
      const a = [ox + ft(w.startXIn), oz + ft(w.startYIn)], b = [ox + ft(w.endXIn), oz + ft(w.endYIn)];
      if (w.isOpen) this.buildOpenEdge(a, b, w, ctx, floorColor);
      else this.buildWall(a, b, w, ctx);
    }
  }

  buildOpenEdge(a, b, w, { cx, cz }, floorColor) {
    const pts = [], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    for (let u = 0; u < L; u += 0.5) pts.push(W(a[0] + dir[0] * u, a[1] + dir[1] * u, 0.01), W(a[0] + dir[0] * Math.min(u + 0.3, L), a[1] + dir[1] * Math.min(u + 0.3, L), 0.01));
    this.roomRoot.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#6b4a2a' })));
    // A 3' strip of floor beyond the open side, labeled with where it leads.
    let n = [-dir[1], dir[0]];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if ((mid[0] - cx) * n[0] + (mid[1] - cz) * n[1] < 0) n = [-n[0], -n[1]];
    const depth = 3;
    const t2 = plankTexture(floorColor); t2.repeat.set(depth / 4, L / 8);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(depth, L), mat('#e9dccb', { map: t2, roughness: 0.6 }));
    strip.rotation.x = -Math.PI / 2;
    strip.rotation.z = Math.atan2(dir[1], dir[0]) - Math.PI / 2;
    strip.position.copy(W(mid[0] + n[0] * depth / 2, mid[1] + n[1] * depth / 2, -0.004)); strip.receiveShadow = true;
    this.roomRoot.add(strip);
    const lbl = textPlane(`OPEN${w.openTo ? ' → ' + w.openTo.toUpperCase() : ''}`, { heightFt: 0.42, color: 'rgba(60,35,15,0.75)' });
    lbl.rotation.z = Math.atan2(dir[1], dir[0]) + (Math.abs(dir[1]) > 0.5 ? 0 : 0);
    lbl.rotation.z = -Math.atan2(-dir[1], dir[0]);
    lbl.position.copy(W(mid[0] + n[0] * depth / 2, mid[1] + n[1] * depth / 2, 0.012)); this.roomRoot.add(lbl);
  }

  buildWall(a, b, w, { cx, cz, wallMat, trim }) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.01) return;
    const T = ft(w.thicknessIn || 5), H = ft(w.heightIn);
    const dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    let n = [-dir[1], dir[0]];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if ((mid[0] - cx) * n[0] + (mid[1] - cz) * n[1] < 0) n = [-n[0], -n[1]];
    const dw = new THREE.Vector3(dir[0], 0, -dir[1]), up = new THREE.Vector3(0, 1, 0), zAxis = new THREE.Vector3().crossVectors(dw, up);
    const nw = new THREE.Vector3(n[0], 0, -n[1]);
    const s = Math.sign(zAxis.dot(nw)) || 1;
    const basis = new THREE.Matrix4().makeBasis(dw, up, zAxis);
    const openings = [...(w.openings ?? [])].sort((p, q) => p.offsetIn - q.offsetIn);
    const slate = mat('#8f8880', { roughness: 0.85 }), firebox = mat('#0c0b0b', { roughness: 1 });
    const glass = new THREE.MeshStandardMaterial({ color: '#a9d4f2', transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.1 });

    const set = { full: new THREE.Group(), cut: new THREE.Group(), anchor: W(a[0], a[1]), normal: nw };
    for (const [key, Hs] of [['full', H], ['cut', Math.min(H, CUT)]]) {
      const g = set[key];
      g.applyMatrix4(basis); g.position.copy(set.anchor);
      // piece in wall-local coords: u along the wall, y up, depth outward from the room face (negative = into the room)
      const piece = (u0, u1, y0, y1, m, d0 = 0, d1 = T) => {
        y1 = Math.min(y1, Hs); if (y1 <= y0 || u1 <= u0) return;
        const mesh = box(u1 - u0, y1 - y0, d1 - d0, m, (u0 + u1) / 2, y0, s * (d0 + d1) / 2);
        mesh.userData.static = true; g.add(mesh);
      };
      let u = -T;
      for (const o of openings) {
        const o0 = ft(o.offsetIn), o1 = o0 + ft(o.widthIn);
        piece(u, o0, 0, H, wallMat);
        if (o.type === 'window') {
          const sill = ft(o.sillIn ?? 30), head = ft(o.headIn ?? 84), f = 0.2;
          piece(o0, o1, 0, sill, wallMat); piece(o0, o1, head, H, wallMat);
          piece(o0 + f, o1 - f, sill, head, glass, T * 0.35, T * 0.65);
          piece(o0, o0 + f, sill, head, trim, -0.03, T); piece(o1 - f, o1, sill, head, trim, -0.03, T);
          piece(o0, o1, head - f, head, trim, -0.03, T); piece(o0 - 0.1, o1 + 0.1, sill - 0.12, sill, trim, -0.15, T);
          if (Hs < sill) piece(o0 + f, o1 - f, Hs - 0.01, Hs, new THREE.MeshBasicMaterial({ color: '#7fb9e6' }), 0.05, T - 0.05);
        } else if (o.type === 'fireplace') {
          const wd = o1 - o0, b0 = o0 + wd * 0.15, b1 = o1 - wd * 0.15, top = ft(o.headIn ?? 33), mantel = 4.5;
          piece(o0, b0, 0, H, wallMat); piece(b1, o1, 0, H, wallMat); piece(b0, b1, top, H, wallMat);
          piece(b0, b1, 0, top - 0.001, firebox, 0.02, T - 0.03);
          piece(o0, b0, 0, mantel, slate, -0.02, 0); piece(b1, o1, 0, mantel, slate, -0.02, 0); piece(b0, b1, top, mantel, slate, -0.02, 0);
          piece(o0 - 0.15, o1 + 0.15, mantel, mantel + 0.12, trim, -0.12, 0);
          if (key === 'full') {
            const hearth = box(o1 - o0, 0.011, 1.3, slate, (o0 + o1) / 2, 0.001, -s * 0.65); hearth.userData.static = true; g.add(hearth);
          }
        } else if (o.type === 'door') {
          piece(o0, o1, ft(o.headIn ?? 80), H, wallMat);
        } else if (o.headIn) {
          piece(o0, o1, ft(o.headIn), H, wallMat);
        }
        u = Math.max(u, o1);
      }
      piece(u, L + T, 0, H, wallMat);
      piece(0, L, 0, 0.33, trim, -0.05, 0); // baseboard
      this.roomRoot.add(g);
    }
    if (openings.some((o) => o.type === 'fireplace')) {
      const o = openings.find((p) => p.type === 'fireplace');
      const um = ft(o.offsetIn + o.widthIn / 2);
      const lbl = textPlane('FIREPLACE', { heightFt: 0.38, color: '#2b2622' });
      lbl.rotation.z = Math.atan2(-dw.z, dw.x);
      lbl.position.copy(W(a[0] + dir[0] * um - n[0] * 0.65, a[1] + dir[1] * um - n[1] * 0.65, 0.02));
      this.roomRoot.add(lbl);
    }
    this.wallSets.push(set);
  }

  updateWallVisibility() {
    const c = this.camera.position, top = this.mode === 'top';
    for (const s of this.wallSets) {
      const near = !top && new THREE.Vector3().subVectors(c, s.anchor).dot(s.normal) > 0;
      const full = this.walls === 'full' && !near;
      s.full.visible = full; s.cut.visible = !full;
    }
  }

  buildFurniture() {
    this.clearGroup(this.furnRoot); this.objects.clear();
    for (const r of this.data?.rooms ?? []) for (const p of r.furniture) {
      const it = p.item, g = new THREE.Group();
      (BUILDERS[it.kind] || BUILDERS.box)(g, ft(it.wIn), ft(it.dIn), ft(it.hIn), it);
      const ghost = p.action === 'remove';
      g.traverse((o) => {
        o.userData.pid = p.id;
        if (ghost && o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.25; o.castShadow = false; }
      });
      const div = document.createElement('div');
      div.className = 'lbl' + (this.highlight.has(`placement:${p.id}`) ? ' changed' : '') + (ghost ? ' ghost' : '');
      div.textContent = it.name + (ghost ? ' (remove)' : '');
      const lbl = new CSS2DObject(div);
      lbl.position.set(0, Math.max(ft(it.hIn), 0.3) + 0.35 + (it.kind === 'tv' ? 2 : 0), it.kind === 'rug' ? ft(it.dIn) / 2 - 1 : 0);
      g.add(lbl); g.userData.labelEl = div;
      if (this.highlight.has(`placement:${p.id}`) || this.highlight.has(`furniture_item:${it.id}`)) {
        const hl = new THREE.BoxHelper(g, '#1e9e5a'); g.userData.hl = hl;
      }
      this.objects.set(p.id, g); this.furnRoot.add(g); this.place(p);
      if (g.userData.hl) { g.updateMatrixWorld(true); g.userData.hl.update(); this.furnRoot.add(g.userData.hl); }
    }
  }
  place(p) {
    const g = this.objects.get(p.id); if (!g) return;
    const r = this.roomOf(p);
    g.position.copy(W(ft(r.originXIn + p.xIn), ft(r.originYIn + p.yIn)));
    g.rotation.y = THREE.MathUtils.degToRad(p.rotationDeg);
    if (g.userData.hl) { g.updateMatrixWorld(true); g.userData.hl.update(); }
  }

  // ---- selection / editing --------------------------------------------------
  select(id) {
    if (this.selHelper) { this.scene.remove(this.selHelper); this.selHelper.geometry.dispose(); this.selHelper = null; }
    for (const g of this.objects.values()) g.userData.labelEl.classList.remove('sel');
    this.selected = id ?? null;
    const g = id != null && this.objects.get(id);
    if (g) { this.selHelper = new THREE.BoxHelper(g, '#ffb400'); this.scene.add(this.selHelper); g.userData.labelEl.classList.add('sel'); }
    this.h.onSelect?.(this, this.selected != null ? this.placement(this.selected) : null);
  }
  snapP(p) {
    if (!this.snap) return;
    const f = footprintFt(p);
    p.xIn = Math.round((Math.round(f.x0 / SNAP_FT) * SNAP_FT + f.w / 2) * 12);
    p.yIn = Math.round((Math.round(f.z0 / SNAP_FT) * SNAP_FT + f.d / 2) * 12);
  }
  clampP(p) {
    const r = this.roomOf(p), b = this.bounds, f = footprintFt(p);
    const lo = (v) => v - ft(r.originXIn);
    p.xIn = Math.round(THREE.MathUtils.clamp(ft(p.xIn), lo(b.minX) + f.w / 2, lo(b.maxX) + 6 - f.w / 2) * 12);
    p.yIn = Math.round(THREE.MathUtils.clamp(ft(p.yIn), b.minZ - ft(r.originYIn) + f.d / 2, b.maxZ - ft(r.originYIn) - f.d / 2) * 12);
  }
  rotateSelected() {
    const p = this.selected != null && this.placement(this.selected); if (!p || !this.editable) return;
    const before = { xIn: p.xIn, yIn: p.yIn, rotationDeg: p.rotationDeg };
    p.rotationDeg = (p.rotationDeg + 90) % 360; this.snapP(p); this.clampP(p); this.place(p);
    this.h.onCommit?.(this, p, before);
  }

  bindPointer() {
    const el = this.renderer.domElement;
    const setNdc = (e) => {
      const r = el.getBoundingClientRect();
      this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(this.ndc, this.camera);
    };
    const floorHit = () => { const p = new THREE.Vector3(); return this.raycaster.ray.intersectPlane(this.floorPlane, p) ? { x: p.x, z: -p.z } : null; };
    const pick = () => this.raycaster.intersectObjects(this.furnRoot.children, true).filter((h) => h.object.userData.pid != null && h.object.isMesh);
    let drag = null, down = null;
    const driving = () => { this.userDriving = true; this.h.onInteract?.(this); };
    el.addEventListener('wheel', driving, { passive: true });
    el.addEventListener('pointerdown', (e) => {
      driving();
      if (e.button !== undefined && e.button !== 0) return;
      setNdc(e); down = { x: e.clientX, y: e.clientY };
      const hits = pick(); if (!hits.length) return;
      const id = hits[0].object.userData.pid; this.select(id);
      if (!this.editable) return;
      const p = this.placement(id), hit = floorHit(); if (!hit) return;
      const r = this.roomOf(p);
      drag = { p, before: { xIn: p.xIn, yIn: p.yIn, rotationDeg: p.rotationDeg }, dx: ft(r.originXIn + p.xIn) - hit.x, dz: ft(r.originYIn + p.yIn) - hit.z, id: e.pointerId, moved: false };
      this.controls.enabled = false; el.setPointerCapture(e.pointerId);
    }, { capture: true });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      setNdc(e); const hit = floorHit(); if (!hit) return;
      const r = this.roomOf(drag.p);
      drag.p.xIn = Math.round((hit.x + drag.dx - ft(r.originXIn)) * 12); drag.p.yIn = Math.round((hit.z + drag.dz - ft(r.originYIn)) * 12);
      drag.moved = true; this.snapP(drag.p); this.clampP(drag.p); this.place(drag.p);
      this.h.onSelect?.(this, drag.p);
    });
    const end = (e) => {
      if (drag) {
        const d = drag; drag = null; this.controls.enabled = true;
        if (d.moved && (d.p.xIn !== d.before.xIn || d.p.yIn !== d.before.yIn)) this.h.onCommit?.(this, d.p, d.before);
        return;
      }
      if (down && e && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) { setNdc(e); if (!pick().length) this.select(null); }
      down = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => { drag = null; this.controls.enabled = true; });
    el.addEventListener('pointerleave', () => { this.userDriving = false; });
    el.addEventListener('pointerenter', () => { this.userDriving = true; });
  }

  // ---- cameras ----------------------------------------------------------------
  center() { const b = this.bounds ?? { minX: 0, maxX: 12, minZ: 0, maxZ: 12 }; return W((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2); }
  fit() {
    const r = this.el.getBoundingClientRect(), aspect = r.width / Math.max(r.height, 1);
    const b = this.bounds, c = this.center(), s = (Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 8) / 13) * Math.max(1, 1.45 / Math.max(aspect, 0.3));
    this.persp.position.set(c.x + 9.5 * s, 15 * s, c.z + 16 * s); this.pc.target.copy(c); this.pc.update();
    this.ortho.position.set(c.x + 1.5, 60, c.z); this.oc.target.set(c.x + 1.5, 0, c.z); this.ortho.zoom = 1;
    this.fitOrtho(); this.oc.update();
  }
  fitOrtho() {
    const r = this.el.getBoundingClientRect(), aspect = r.width / Math.max(r.height, 1);
    const b = this.bounds ?? { minX: 0, maxX: 12, minZ: 0, maxZ: 12 };
    const needW = b.maxX - b.minX + 9, needH = b.maxZ - b.minZ + 4;
    let halfH = needH / 2, halfW = halfH * aspect;
    if (halfW < needW / 2) { halfW = needW / 2; halfH = halfW / aspect; }
    Object.assign(this.ortho, { left: -halfW, right: halfW, top: halfH, bottom: -halfH }); this.ortho.updateProjectionMatrix();
  }
  setMode(mode) {
    this.mode = mode; this.controls.enabled = false;
    if (mode === 'top') { this.camera = this.ortho; this.controls = this.oc; this.fitOrtho(); }
    else { this.camera = this.persp; this.controls = this.pc; }
    this.sun.castShadow = mode !== 'top';
    this.controls.enabled = true; this.controls.update();
  }
  getCamera() {
    return { mode: this.mode, position: this.camera.position.toArray(), target: this.controls.target.toArray(), zoom: this.camera.zoom };
  }
  setCamera(s) {
    if (s.mode !== this.mode) this.setMode(s.mode);
    this.camera.position.fromArray(s.position); this.controls.target.fromArray(s.target);
    this.camera.zoom = s.zoom; this.camera.updateProjectionMatrix();
    this.controls.update();
  }
  resize() {
    const r = this.el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height); this.labels.setSize(r.width, r.height);
    this.persp.aspect = r.width / r.height; this.persp.updateProjectionMatrix();
    this.fitOrtho();
  }
  dispose() {
    this.renderer.setAnimationLoop(null); this.renderer.dispose();
    this.clearGroup(this.furnRoot); this.clearGroup(this.roomRoot);
    this.el.innerHTML = '';
  }
}
