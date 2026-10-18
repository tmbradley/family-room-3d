// RoomView: one 3D/top view of a workspace's rooms, built from API data (inches).
// Room coords: x = xIn/12 ft, z = yIn/12 ft. World = (x, y, -z) so the back wall is at the top in top view.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { USDLoader } from 'three/addons/loaders/USDLoader.js';

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

// ---------------------------------------------------------------------------
// Parametric templates (server/templates.ts). Same local frame as above; params arrive as strings.
// ---------------------------------------------------------------------------
let TEMPLATE_DEFAULTS = new Map(); // slug -> { key: default }
export function setTemplates(list) {
  TEMPLATE_DEFAULTS = new Map(list.map((t) => [t.slug, Object.fromEntries(t.params.map((p) => [p.key, p.default]))]));
}
const WOOD = { walnut: '#5a3a22', oak: '#a87a4a', white_oak: '#c9a978', ebony: '#2a201b', painted_white: '#efece6' };
const METAL = { brass: '#b8913f', black: '#1d1d1d', chrome: '#c9ccd0', bronze: '#6e4b2e' };
const woodMat = (prm) => mat(WOOD[prm.woodTone] ?? WOOD.walnut, { roughness: 0.55 });
const metalMat = (prm) => mat(METAL[prm.metalFinish] ?? METAL.brass, { metalness: 0.85, roughness: 0.3 });
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
/** Legs (or a plinth) under a w x d footprint; returns the leg height used (ft). */
function templateLegs(g, w, d, prm, legMat, inset = 0.2) {
  const h = ft(num(prm.legHeightIn, 4));
  const style = prm.legStyle ?? 'tapered';
  if (h <= 0.01) return 0;
  if (style === 'plinth') { g.add(box(w - 0.15, h, d - 0.15, mat('#2b2522', { roughness: 0.8 }), 0, 0, 0)); return h; }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w / 2 - inset), z = sz * (d / 2 - inset);
    if (style === 'block') g.add(box(0.22, h, 0.22, legMat, x, 0, z));
    else if (style === 'metal') { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, h, 8), legMat); m.position.set(x, h / 2, z); m.castShadow = true; g.add(m); }
    else g.add(taperedLeg(h, legMat, x, z));
  }
  return h;
}
function seat(g, w, d, h, prm, { fabric, legs, arms = true, back = true }) {
  const base = templateLegs(g, w, d, prm, legs, 0.3);
  const armStyle = arms ? prm.armStyle ?? 'track' : 'none', arm = armStyle === 'none' ? 0 : 0.45;
  const seatD = Math.min(d - 0.3, ft(num(prm.seatDepthIn, 22)) + 0.2), backD = Math.max(0.35, d - seatD);
  const seatH = Math.max(0.6, 1.5 - base);
  g.add(box(w, 0.45, d, fabric, 0, base, 0));
  if (back) g.add(box(w, Math.max(h - base - 0.45, 0.4), backD, fabric, 0, base + 0.45, -d / 2 + backD / 2));
  if (arm) for (const s of [-1, 1]) {
    const ah = armStyle === 'slope' ? 0.75 : 1.0;
    const a = box(arm, ah, d, fabric, s * (w / 2 - arm / 2), base + 0.45, 0);
    g.add(a);
    if (armStyle === 'rolled') { const r = new THREE.Mesh(new THREE.CylinderGeometry(arm * 0.6, arm * 0.6, d, 16), fabric); r.rotation.x = Math.PI / 2; r.position.set(s * (w / 2 - arm / 2), base + 0.45 + ah, 0); r.castShadow = true; g.add(r); }
  }
  const n = Math.max(1, Math.round(num(prm.cushionCount, w > 5 ? 3 : 1))), cw = (w - 2 * arm) / n;
  const cush = mat(prm.fabricColor || '#5b5f66', { roughness: 1 });
  for (let i = 0; i < n; i++) g.add(box(cw - 0.05, Math.min(0.38, seatH * 0.5), seatD - 0.05, cush, -w / 2 + arm + cw * (i + 0.5), base + 0.45, d / 2 - seatD / 2));
}
const TEMPLATE_BUILDERS = {
  sofa(g, w, d, h, prm) { seat(g, w, d, h, prm, { fabric: mat(prm.fabricColor, { roughness: 0.95 }), legs: prm.legStyle === 'metal' ? metalMat(prm) : woodMat(prm) }); },
  armchair(g, w, d, h, prm) { seat(g, w, d, h, { ...prm, cushionCount: 1 }, { fabric: mat(prm.fabricColor, { roughness: 0.9 }), legs: prm.legStyle === 'metal' ? metalMat(prm) : woodMat(prm) }); },
  swivel_chair(g, w, d, h, prm) {
    const fab = mat(prm.fabricColor, { roughness: 0.9 }), met = metalMat(prm), r = Math.min(w, d) / 2;
    if (prm.baseStyle === 'star') for (let i = 0; i < 5; i++) { const a = box(r * 0.9, 0.08, 0.12, met, 0, 0.05, 0); a.geometry.translate(r * 0.45, 0, 0); a.rotation.y = (i * 2 * Math.PI) / 5; g.add(a); }
    else { const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.75, r * 0.8, 0.08, 32), met); disc.position.y = 0.04; g.add(disc); }
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.7, 12), met); post.position.y = 0.4; g.add(post);
    const tub = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.92, 0.75, 32, 1, false, Math.PI * 0.15, Math.PI * 1.7), fab);
    tub.rotation.y = Math.PI / 2 + Math.PI * 0.0; tub.position.y = 0.75 + 0.375; tub.castShadow = true; g.add(tub);
    const back = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.max(h - 1.5, 0.4), 32, 1, true, Math.PI * 0.65, Math.PI * 0.7), mat(prm.fabricColor, { side: THREE.DoubleSide }));
    back.position.y = 1.5 + Math.max(h - 1.5, 0.4) / 2; g.add(back);
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r * 0.85, 0.3, 32), mat(prm.fabricColor, { roughness: 1 })); c.position.y = 1.3; g.add(c);
  },
  l_sectional(g, w, d, h, prm) {
    // A run across the back (w) plus a chaise along one end, chaiseDepthIn long (clamped to d).
    const fab = mat(prm.fabricColor, { roughness: 0.95 }), cush = mat(prm.fabricColor, { roughness: 1 });
    const legs = prm.legStyle === 'metal' ? metalMat(prm) : woodMat(prm);
    const side = prm.chaiseSide === 'left' ? -1 : 1;
    const seatD = Math.min(ft(num(prm.seatDepthIn, 22)) + 0.95, d * 0.6), backD = 0.7, base = Math.max(ft(num(prm.legHeightIn, 4)), 0.01), cushH = 0.35;
    const chL = Math.min(ft(num(prm.chaiseDepthIn, 66)), d), chW = num(prm.chaiseWidthIn, 0) > 0 ? Math.min(ft(num(prm.chaiseWidthIn, 0)), w * 0.6) : seatD;
    // Attached ottoman: in front of the run at the end away from the chaise (RoomPlan sees it as its own "sofa" box).
    const oSide = prm.ottomanSide === 'left' ? -1 : prm.ottomanSide === 'right' ? 1 : 0;
    if (oSide && oSide !== side) {
      const ow = Math.min(ft(num(prm.ottomanWidthIn, 36)), w - chW), od = Math.min(ft(num(prm.ottomanDepthIn, 30)), d - seatD);
      const ob = Math.max(ft(num(prm.legHeightIn, 4)), 0.01);
      g.add(box(ow, 0.9, od, fab, oSide * (w / 2 - ow / 2), ob, -d / 2 + seatD + od / 2));
      g.add(box(ow - 0.06, 0.35, od - 0.05, cush, oSide * (w / 2 - ow / 2), ob + 0.9, -d / 2 + seatD + od / 2));
    }
    const armStyle = prm.armStyle ?? 'track', arm = armStyle === 'none' ? 0 : 0.45;
    if (prm.legStyle !== 'plinth' && base > 0.02) {
      for (const [x, z] of [[-w / 2 + 0.25, -d / 2 + 0.25], [w / 2 - 0.25, -d / 2 + 0.25], [-side * (w / 2 - 0.25), -d / 2 + seatD - 0.25], [side * (w / 2 - 0.25), -d / 2 + chL - 0.25], [side * (w / 2 - chW + 0.25), -d / 2 + chL - 0.25]])
        g.add(prm.legStyle === 'block' ? box(0.2, base, 0.2, legs, x, 0, z) : taperedLeg(base, legs, x, z));
    }
    const seatTop = base + 0.9;
    g.add(box(w, 0.9, seatD, fab, 0, base, -d / 2 + seatD / 2));                       // back run
    g.add(box(chW, 0.9, chL - seatD, fab, side * (w / 2 - chW / 2), base, -d / 2 + seatD + (chL - seatD) / 2)); // chaise
    g.add(box(w, Math.max(h - seatTop, 0.5), backD, fab, 0, seatTop, -d / 2 + backD / 2));
    if (arm) {
      g.add(box(arm, armStyle === 'slope' ? 0.6 : 0.85, seatD, fab, -side * (w / 2 - arm / 2), seatTop, -d / 2 + seatD / 2));
    }
    const n = Math.max(1, Math.round(num(prm.cushionCount, 3))), runW = w - chW - arm, cw = runW / n;
    const x0 = side > 0 ? -w / 2 + arm : -w / 2 + chW;
    for (let i = 0; i < n; i++) g.add(box(cw - 0.06, cushH, seatD - backD - 0.05, cush, x0 + cw * (i + 0.5), seatTop, -d / 2 + backD + (seatD - backD) / 2));
    g.add(box(chW - 0.06, cushH, chL - backD - 0.05, cush, side * (w / 2 - chW / 2), seatTop, -d / 2 + backD + (chL - backD) / 2));
  },
  coffee_table(g, w, d, h, prm) {
    const top = woodMat(prm), legM = prm.legStyle === 'metal' ? metalMat(prm) : woodMat(prm), t = 0.12;
    if (prm.shape === 'round' || prm.shape === 'oval') {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, t, 48), top); m.scale.set(w, 1, prm.shape === 'round' ? w : d); m.position.y = h - t / 2; m.castShadow = true; g.add(m);
      if (prm.legStyle === 'plinth') { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, h - t, 32), top); b.scale.set(w * 0.55, 1, (prm.shape === 'round' ? w : d) * 0.55); b.position.y = (h - t) / 2; g.add(b); }
      else for (let i = 0; i < 4; i++) { const a = (i * Math.PI) / 2 + Math.PI / 4; g.add(taperedLeg(h - t, legM, Math.cos(a) * w * 0.32, Math.sin(a) * (prm.shape === 'round' ? w : d) * 0.32)); }
    } else {
      g.add(box(w, t, d, top, 0, h - t, 0));
      if (prm.legStyle === 'plinth') g.add(box(w - 0.4, h - t, d - 0.4, top, 0, 0, 0));
      else templateLegs(g, w, d, { ...prm, legHeightIn: (h - t) * 12 }, legM, 0.22);
    }
  },
  side_table(g, w, d, h, prm) { TEMPLATE_BUILDERS.coffee_table(g, w, prm.shape === 'round' ? w : d, h, { ...prm, legStyle: 'metal' }); },
  media_console(g, w, d, h, prm) {
    const wood = woodMat(prm), pull = metalMat(prm);
    const base = templateLegs(g, w, d, prm, prm.legStyle === 'metal' ? pull : wood, 0.2);
    g.add(box(w, h - base, d, wood, 0, base, 0));
    const n = Math.round(num(prm.doorCount, 3));
    for (let i = 1; i < n; i++) g.add(box(0.03, h - base - 0.2, 0.02, mat('#2a1c12'), -w / 2 + (i * w) / n, base + 0.1, d / 2 + 0.005));
    for (let i = 0; i < n; i++) g.add(box(0.25, 0.04, 0.04, pull, -w / 2 + ((i + 0.5) * w) / n, base + (h - base) * 0.75, d / 2 + 0.02));
  },
  rug(g, w, d, h, prm) {
    const pattern = prm.pattern ?? 'solid', color = prm.rugColor || '#9a9184';
    if (pattern === 'solid') { const m = box(w, 0.04, d, mat(color, { roughness: 1 }), 0, 0.003, 0); m.castShadow = false; g.add(m); return; }
    BUILDERS.rug(g, w, d, h, { color, accentColor: '#3d3a36', ...(pattern === 'border' ? { accent: '#3d3a36' } : {}) });
  },
  floor_lamp(g, w, d, h, prm) {
    const met = metalMat(prm), shadeM = mat(prm.shadeColor || '#efe7d8', { side: THREE.DoubleSide, emissive: '#5a4a30', emissiveIntensity: 0.4 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.4, w * 0.45, 0.08, 24), met); base.position.y = 0.04; g.add(base);
    if (prm.arc === 'true') {
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, h * 1.1, 0), new THREE.Vector3(0, h * 0.85, d / 2 + 2.5));
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.03, 8), met); tube.castShadow = true; g.add(tube);
      const shade = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), shadeM); shade.position.set(0, h * 0.85 - 0.5, d / 2 + 2.5); g.add(shade);
    } else BUILDERS.lamp(g, w, d, h, { color: METAL[prm.metalFinish] ?? METAL.brass });
  },
  bed(g, w, d, h, prm) {
    const fab = mat(prm.fabricColor, { roughness: 0.95 }), wood = woodMat(prm);
    const base = templateLegs(g, w, d, { ...prm, legStyle: 'block' }, wood, 0.2);
    g.add(box(w, 0.6, d, prm.headboard === 'wood' ? wood : fab, 0, base, 0));
    g.add(box(w - 0.1, 0.8, d - 0.3, mat('#f3f1ec', { roughness: 1 }), 0, base + 0.6, 0.1));
    g.add(box(w - 0.1, 0.12, d * 0.62, mat(prm.fabricColor, { roughness: 1 }), 0, base + 1.4, d / 2 - (d * 0.62) / 2));
    for (const s of [-1, 1]) g.add(box(w / 2 - 0.4, 0.35, 1.2, mat('#ffffff', { roughness: 1 }), s * w / 4, base + 1.4, -d / 2 + 1));
    if (prm.headboard !== 'none') g.add(box(w + 0.2, Math.max(h - 0.1, 2.5), 0.3, prm.headboard === 'wood' ? wood : fab, 0, 0, -d / 2 - 0.15));
  },
  dresser(g, w, d, h, prm) {
    const wood = woodMat(prm), pull = metalMat(prm);
    const base = templateLegs(g, w, d, prm, prm.legStyle === 'metal' ? pull : wood, 0.2);
    g.add(box(w, h - base, d, wood, 0, base, 0));
    const n = Math.max(1, Math.round(num(prm.drawerCount, 6))), cols = n >= 6 ? 2 : 1, rows = Math.ceil(n / cols), dh = (h - base - 0.1) / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols && r * cols + c < n; c++) {
      const x = -w / 2 + (c + 0.5) * (w / cols), y = base + 0.05 + r * dh;
      g.add(box(w / cols - 0.08, 0.02, 0.02, mat('#2a1c12'), x, y + dh - 0.02, d / 2 + 0.005));
      g.add(box(0.3, 0.04, 0.04, pull, x, y + dh / 2, d / 2 + 0.02));
    }
  },
  nightstand(g, w, d, h, prm) { TEMPLATE_BUILDERS.dresser(g, w, d, h, prm); },
  desk(g, w, d, h, prm) {
    const wood = woodMat(prm), legM = prm.legStyle === 'metal' ? metalMat(prm) : wood, t = 0.1;
    g.add(box(w, t, d, wood, 0, h - t, 0));
    templateLegs(g, w, d, { ...prm, legHeightIn: (h - t) * 12 }, legM, 0.12);
    if (prm.drawers !== 'false') g.add(box(w * 0.45, 0.35, d - 0.2, wood, w * 0.2, h - t - 0.35, 0));
  },
  bookshelf(g, w, d, h, prm) {
    const wood = woodMat(prm), t = 0.06;
    for (const s of [-1, 1]) g.add(box(t, h, d, wood, s * (w / 2 - t / 2), 0, 0));
    if (prm.backPanel !== 'false') g.add(box(w, h, 0.03, wood, 0, 0, -d / 2 + 0.015));
    const n = Math.max(1, Math.round(num(prm.shelfCount, 5)));
    for (let i = 0; i <= n; i++) g.add(box(w - 2 * t, t, d, wood, 0, (i * (h - t)) / n, 0));
    const colors = ['#7a3b2e', '#2e4a7a', '#c9a227', '#3b6e4a', '#e6e0d4'];
    for (let i = 0; i < n; i++) for (let k = 0; k < 6; k++) { const bw = (w - 2 * t) / 9; g.add(box(bw * 0.9, ((h - t) / n) * 0.7, d * 0.7, mat(colors[(i + k) % 5]), -w / 2 + t + bw * (k + 0.6), (i * (h - t)) / n + t, 0)); }
  },
};
/** Build a placement's template (params over template defaults). Returns false if unknown. */
function buildTemplate(g, p, it) {
  const t = p.template, f = t && TEMPLATE_BUILDERS[t.slug];
  if (!f) return false;
  const prm = { ...(TEMPLATE_DEFAULTS.get(t.slug) ?? {}), ...t.params };
  f(g, ft(it.wIn), ft(it.dIn), ft(it.hIn), prm, it);
  return true;
}

// 3D models (Object Capture USDZ or uploaded GLB/USDZ), fetched same-origin, cached per file.
const modelCache = new Map();
function loadModel(m) {
  if (!modelCache.has(m.fileUrl)) {
    const loader = m.format === 'glb' ? new GLTFLoader() : new USDLoader();
    modelCache.set(m.fileUrl, loader.loadAsync(m.fileUrl).then((r) => r.scene ?? r));
  }
  return modelCache.get(m.fileUrl);
}
/** Fit a model into the item's footprint: uniform scale, centered, standing on the floor. */
function fitModel(obj, it) {
  const o = obj.clone(true);
  o.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(o), size = b.getSize(new THREE.Vector3());
  if (!isFinite(size.x) || size.x <= 0 || size.z <= 0) throw new Error('empty model');
  const s = Math.min(ft(it.wIn) / size.x, ft(it.dIn) / size.z, it.hIn > 0 ? ft(it.hIn) / Math.max(size.y, 1e-6) : Infinity);
  const wrap = new THREE.Group(); wrap.add(o);
  o.scale.multiplyScalar(s);
  o.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(o), c = b2.getCenter(new THREE.Vector3());
  o.position.sub(new THREE.Vector3(c.x, b2.min.y, c.z));
  o.traverse((x) => { if (x.isMesh) { x.castShadow = true; x.receiveShadow = true; } });
  return wrap;
}

export const footprintFt = (p) => {
  const r = ((p.rotationDeg % 360) + 360) % 360, sw = r === 90 || r === 270;
  const w = ft(sw ? p.item.dIn : p.item.wIn), d = ft(sw ? p.item.wIn : p.item.dIn);
  const x = ft(p.xIn), z = ft(p.yIn);
  return { w, d, x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 };
};

// ---------------------------------------------------------------------------
/** Comparison colors: added green, changed amber, removed red. */
export const MARK_COLORS = { added: '#1e9e5a', changed: '#f0b400', removed: '#a3341f' };

export class RoomView {
  constructor(container, handlers = {}) {
    this.el = container;
    this.h = handlers;
    this.mode = '3d'; this.walls = 'cut'; this.snap = true; this.editable = false;
    this.data = null; this.selected = null; this.highlight = new Set();
    this.objects = new Map(); this.wallSets = [];

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
      this.h.onFrame?.(this);
    });
  }

  // ---- data -----------------------------------------------------------------
  /**
   * highlight: entity keys ("placement:12", "furniture_item:3") drawn as changed (green box, legacy).
   * marks: { "placement:12": 'added' | 'changed' | 'removed' } drawn green / amber / red. Pieces with
   * `_removed: true` (shown from the other side of a comparison) are drawn as red ghosts.
   */
  setData(ws, { editable = false, highlight = [], marks = null } = {}) {
    const first = !this.data;
    this.data = ws; this.editable = editable; this.highlight = new Set(highlight); this.marks = marks ?? {};
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
      if (!buildTemplate(g, p, it)) (BUILDERS[it.kind] || BUILDERS.box)(g, ft(it.wIn), ft(it.dIn), ft(it.hIn), it);
      const mark = p._removed ? 'removed' : this.marks?.[`placement:${p.id}`] ?? this.marks?.[`furniture_item:${it.id}`]
        ?? (this.highlight.has(`placement:${p.id}`) || this.highlight.has(`furniture_item:${it.id}`) ? 'added' : null);
      const ghost = p.action === 'remove' || mark === 'removed';
      g.traverse((o) => {
        o.userData.pid = p.id;
        if (ghost && o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.25; o.castShadow = false; }
      });
      const div = document.createElement('div');
      div.className = 'lbl' + (mark ? ` changed mark-${mark}` : '') + (ghost ? ' ghost' : '');
      div.textContent = it.name + (mark === 'removed' ? ' (removed)' : ghost ? ' (remove)' : '');
      if (p.model) {
        // The model wins over the template. Until it loads (or if it can't), the template stands in with a badge.
        const badge = document.createElement('span'); badge.className = 'badge-model'; badge.textContent = 'custom model'; div.appendChild(badge);
        loadModel(p.model).then((obj) => {
          if (this.objects.get(p.id) !== g) return; // rebuilt meanwhile
          const fitted = fitModel(obj, it);
          for (const c of [...g.children]) if (!c.isCSS2DObject && c !== g.userData.hl) g.remove(c);
          fitted.traverse((o) => { o.userData.pid = p.id; if (ghost && o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.25; } });
          g.add(fitted);
          badge.textContent = '3D model'; badge.classList.add('loaded');
          if (this.selected === p.id) this.select(p.id);
        }).catch((err) => { console.warn('model', p.model.fileUrl, err); badge.textContent = 'custom model (showing template)'; badge.classList.add('failed'); });
      }
      const lbl = new CSS2DObject(div);
      lbl.position.set(0, Math.max(ft(it.hIn), 0.3) + 0.35 + (it.kind === 'tv' ? 2 : 0), it.kind === 'rug' ? ft(it.dIn) / 2 - 1 : 0);
      g.add(lbl); g.userData.labelEl = div;
      if (mark) {
        const hl = new THREE.BoxHelper(g, MARK_COLORS[mark] ?? MARK_COLORS.added); g.userData.hl = hl;
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
  /** Where a piece is on screen (px, relative to the view): the top-center of its bounding box. */
  screenOf(id) {
    const g = id != null && this.objects.get(id); if (!g) return null;
    const box = new THREE.Box3().setFromObject(g);
    if (box.isEmpty()) return null;
    const v = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2).project(this.camera);
    const r = this.el.getBoundingClientRect();
    if (v.z > 1) return null; // behind the camera
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height, w: r.width, h: r.height };
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
