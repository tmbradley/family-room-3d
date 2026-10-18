// Mood pieces: lighting, wall decor, soft goods, plants and the furniture added with them.
// Builders share scene.js's local frame: centered footprint, y = 0 on the floor (or the top of the
// furniture under a surface/soft piece), front faces +Z, the back (-Z) against the wall for wall
// pieces. Sizes in feet. Low-poly on purpose: they must read from the top view and the 3D view.
// Lights: shades and bulbs are emissive; each lit piece leaves a marker (userData.light) and the
// view turns only the few most important markers into real PointLights.
import * as THREE from 'three';

const ft = (i) => i / 12;
export const truthy = (v) => v === true || v === 'true';
const num = (v, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, ...o });
export const WOOD = { walnut: '#5a3a22', oak: '#a87a4a', white_oak: '#c9a978', ebony: '#2a201b', painted_white: '#efece6' };
export const METAL = { brass: '#b8913f', black: '#1d1d1d', chrome: '#c9ccd0', bronze: '#6e4b2e' };
export const KELVIN = { 2200: '#ffa95a', 2700: '#ffc184', 3000: '#ffd3a6' };
const kColor = (p) => KELVIN[p.bulbK] ?? KELVIN[2700];
const woodM = (tone, o = {}) => mat(WOOD[tone] ?? WOOD.walnut, { roughness: 0.55, ...o });
const metalM = (finish) => mat(METAL[finish] ?? METAL.brass, { metalness: 0.85, roughness: 0.3 });
const rng = (seed) => { let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; };

function mesh(geo, m, x = 0, y = 0, z = 0) { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; return o; }
/** Box standing on y (bottom). */
function box(w, h, d, m, x = 0, y = 0, z = 0) { return mesh(new THREE.BoxGeometry(Math.max(w, 0.005), Math.max(h, 0.005), Math.max(d, 0.005)), m, x, y + h / 2, z); }
/** Cylinder standing on y (bottom). */
function cyl(rt, rb, h, m, x = 0, y = 0, z = 0, seg = 20, open = false) { return mesh(new THREE.CylinderGeometry(rt, rb, Math.max(h, 0.005), seg, 1, open), m, x, y + h / 2, z); }
function sph(r, m, x = 0, y = 0, z = 0, ws = 16, hs = 10) { return mesh(new THREE.SphereGeometry(r, ws, hs), m, x, y, z); }
function rod(a, b, r, m, seg = 6) { // thin cylinder from point a to point b
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), L = A.distanceTo(B);
  const o = mesh(new THREE.CylinderGeometry(r, r, Math.max(L, 0.005), seg), m);
  o.position.copy(A).add(B).multiplyScalar(0.5);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  return o;
}
function tube(points, r, m, seg = 24) { const o = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))), seg, r, 6), m); return o; }

// ---- textures (cached) -------------------------------------------------------
const texCache = new Map();
function canvasTex(key, w, h, draw, repeat = null) {
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  texCache.set(key, t); return t;
}
const weaveTex = (color = '#b8915e') => canvasTex(`weave${color}`, 64, 64, (g, w, h) => {
  g.fillStyle = color; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(60,35,10,0.45)'; g.lineWidth = 3;
  for (let i = -w; i < w * 2; i += 8) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke(); g.beginPath(); g.moveTo(i + h, 0); g.lineTo(i, h); g.stroke(); }
}, [3, 3]);
const noiseTex = (color, key = 'n') => canvasTex(`noise${key}${color}`, 64, 64, (g, w, h) => {
  g.fillStyle = color; g.fillRect(0, 0, w, h); const r = rng(9);
  for (let i = 0; i < 500; i++) { g.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '0,0,0'},${0.05 + r() * 0.12})`; g.beginPath(); g.arc(r() * w, r() * h, 1 + r() * 2.5, 0, Math.PI * 2); g.fill(); }
}, [2, 2]);
/** Limewash: soft clouds of lighter and darker wash over the color. */
export const limewashTex = (color) => canvasTex(`lime${color}`, 256, 256, (g, w, h) => {
  g.fillStyle = color; g.fillRect(0, 0, w, h); const r = rng(31);
  for (let i = 0; i < 70; i++) {
    const x = r() * w, y = r() * h, rad = 20 + r() * 60, light = r() > 0.45;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(${light ? '255,252,245' : '40,30,20'},${light ? 0.16 : 0.1})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  g.globalAlpha = 0.05; g.strokeStyle = '#fff'; g.lineWidth = 6;
  for (let i = 0; i < 40; i++) { g.beginPath(); const x = r() * w, y = r() * h; g.moveTo(x, y); g.quadraticCurveTo(x + 30, y - 20, x + 60 * r(), y + 40 * r()); g.stroke(); }
}, [1, 1]);
/** Halo for light washes: 'radial', 'up' (bright at the bottom) or 'down'. */
const haloTex = (kind) => canvasTex(`halo${kind}`, 128, 128, (g, w, h) => {
  const gr = kind === 'radial' ? g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2) : g.createLinearGradient(0, kind === 'up' ? h : 0, 0, kind === 'up' ? 0 : h);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
function halo(w, h, color, kind = 'radial', opacity = 0.55) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, map: haloTex(kind), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  m.userData.halo = true; m.renderOrder = 2; return m;
}
const flameTex = () => canvasTex('flame', 128, 64, (g, w, h) => {
  const gr = g.createLinearGradient(0, h, 0, 0); gr.addColorStop(0, '#ffdf7a'); gr.addColorStop(0.4, '#ff8a2a'); gr.addColorStop(1, 'rgba(255,60,0,0)');
  g.fillStyle = gr; const r = rng(5);
  for (let i = 0; i < 9; i++) { const x = (i + 0.5) * (w / 9), fw = w / 9, fh = h * (0.5 + r() * 0.5); g.beginPath(); g.moveTo(x - fw, h); g.quadraticCurveTo(x - fw * 0.2, h - fh * 0.6, x, h - fh); g.quadraticCurveTo(x + fw * 0.2, h - fh * 0.6, x + fw, h); g.fill(); }
});
function shade(c, f) { // lighten (f > 0) or darken a hex color
  const n = parseInt(String(c).slice(1, 7), 16); if (!Number.isFinite(n)) return c;
  const ch = (v) => Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f));
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}
/** Simple art for frames, by style and main color. */
const artTex = (style, color, seed = 1) => canvasTex(`art${style}${color}${seed}`, 128, 160, (g, w, h) => {
  const r = rng(seed * 97 + 3);
  if (style === 'landscape') {
    const sky = g.createLinearGradient(0, 0, 0, h * 0.6); sky.addColorStop(0, shade(color, 0.75)); sky.addColorStop(1, shade(color, 0.45)); g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = shade(color, 0.85); g.beginPath(); g.arc(w * 0.7, h * 0.3, 14, 0, Math.PI * 2); g.fill();
    for (const [y, f] of [[0.55, -0.1], [0.68, -0.35], [0.82, -0.55]]) { g.fillStyle = shade(color, f); g.beginPath(); g.moveTo(0, h); g.lineTo(0, h * y); for (let x = 0; x <= w; x += 16) g.lineTo(x, h * y - r() * 18); g.lineTo(w, h); g.fill(); }
  } else if (style === 'botanical') {
    g.fillStyle = '#f2ece0'; g.fillRect(0, 0, w, h); g.strokeStyle = shade(color, -0.3); g.fillStyle = shade(color, -0.1); g.lineWidth = 2;
    g.beginPath(); g.moveTo(w / 2, h * 0.9); g.quadraticCurveTo(w * 0.45, h * 0.5, w / 2, h * 0.12); g.stroke();
    for (let i = 0; i < 8; i++) { const y = h * (0.2 + i * 0.09), s = i % 2 ? 1 : -1; g.beginPath(); g.ellipse(w / 2 + s * 16, y, 16, 6, s * -0.5, 0, Math.PI * 2); g.fill(); }
  } else if (style === 'line') {
    g.fillStyle = '#f4efe6'; g.fillRect(0, 0, w, h); g.strokeStyle = '#1d1d1d'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(w * 0.2, h * 0.75);
    g.bezierCurveTo(w * 0.1, h * 0.2, w * 0.6, h * 0.1, w * 0.55, h * 0.45); g.bezierCurveTo(w * 0.5, h * 0.8, w * 0.95, h * 0.6, w * 0.8, h * 0.3); g.stroke();
    g.fillStyle = color; g.beginPath(); g.arc(w * 0.66, h * 0.62, 10, 0, Math.PI * 2); g.fill();
  } else if (style === 'photo') {
    const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#d9d6d0'); gr.addColorStop(1, '#4a4844'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(20,20,20,0.5)'; g.fillRect(w * 0.15, h * 0.55, w * 0.7, h * 0.08); g.beginPath(); g.arc(w * 0.5, h * 0.4, 22, 0, Math.PI * 2); g.fill();
  } else { // abstract
    g.fillStyle = '#efe8dc'; g.fillRect(0, 0, w, h);
    const cols = [color, shade(color, -0.35), shade(color, 0.4), '#2b2a28'];
    for (let i = 0; i < 4; i++) { g.fillStyle = cols[i]; g.beginPath(); g.ellipse(w * (0.25 + r() * 0.5), h * (0.2 + r() * 0.6), 18 + r() * 30, 14 + r() * 34, r() * 3, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = cols[3]; g.fillRect(w * 0.1, h * (0.7 + r() * 0.1), w * 0.5, 3);
  }
});
const marbleTex = () => canvasTex('marble', 128, 128, (g, w, h) => {
  g.fillStyle = '#ece8e1'; g.fillRect(0, 0, w, h); const r = rng(13); g.strokeStyle = 'rgba(120,115,110,0.35)';
  for (let i = 0; i < 6; i++) { g.lineWidth = 0.6 + r() * 1.4; g.beginPath(); g.moveTo(0, r() * h); for (let x = 0; x <= w; x += 16) g.lineTo(x, r() * h * 0.2 + (i * h) / 6); g.stroke(); }
});
const flutedTex = () => canvasTex('fluted', 64, 8, (g, w, h) => {
  for (let x = 0; x < w; x += 4) { const gr = g.createLinearGradient(x, 0, x + 4, 0); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.5, 'rgba(190,200,200,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0.9)'); g.fillStyle = gr; g.fillRect(x, 0, 4, h); }
}, [6, 1]);

// ---- shades and bulbs --------------------------------------------------------
function shadeMat(material, k, lit, color) {
  if (material === 'rattan') return mat('#ffffff', { map: weaveTex(), roughness: 1, side: THREE.DoubleSide, emissive: k, emissiveIntensity: lit ? 0.35 : 0, transparent: true, opacity: 0.95 });
  if (material === 'brass') return mat(METAL.brass, { metalness: 0.85, roughness: 0.3, side: THREE.DoubleSide });
  if (material === 'metal') return mat(color ?? METAL.black, { metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide });
  if (material === 'glass') return new THREE.MeshStandardMaterial({ color: '#f6eedf', transparent: true, opacity: 0.6, roughness: 0.1, side: THREE.DoubleSide, emissive: k, emissiveIntensity: lit ? 0.85 : 0 });
  // paper and fabric shades glow through
  return mat(color ?? '#f6efe2', { side: THREE.DoubleSide, roughness: 0.95, emissive: k, emissiveIntensity: lit ? (material === 'paper' ? 0.9 : 0.55) : 0 });
}
/** A shade centered on y = 0. shape: globe, drum, cone, ufo_paper, pleated, dome/mushroom. */
function shadeGeo(shape, r, h) {
  if (shape === 'globe') return new THREE.SphereGeometry(r, 18, 12);
  if (shape === 'ufo_paper') { const g = new THREE.SphereGeometry(r, 20, 10); g.scale(1, 0.42, 1); return g; }
  if (shape === 'cone') return new THREE.CylinderGeometry(r * 0.3, r, h, 24, 1, true);
  if (shape === 'dome' || shape === 'mushroom') { const g = new THREE.SphereGeometry(r, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2); g.scale(1, h / r, 1); g.translate(0, -h / 2, 0); return g; }
  if (shape === 'pleated') {
    const g = new THREE.CylinderGeometry(r * 0.78, r, h, 48, 1, true), pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i), a = Math.atan2(z, x), s = 1 + 0.06 * Math.sign(Math.sin(a * 24)); pos.setX(i, x * s); pos.setZ(i, z * s); }
    g.computeVertexNormals(); return g;
  }
  return new THREE.CylinderGeometry(r, r, h, 24, 1, true); // drum
}
function bulb(k, lit, r, x, y, z) { return sph(r, new THREE.MeshBasicMaterial({ color: lit ? k : '#e6e0d4' }), x, y, z, 10, 8); }

// ---- wall placement (same as server/mounting.ts) -----------------------------
/** Pose for a piece hung on wall `wallId` at `offsetIn` along it, its back on the wall face. */
export function wallPose(walls, wallId, offsetIn, depthIn) {
  const w = walls.find((x) => x.id === wallId); if (!w) return null;
  const dx = w.endXIn - w.startXIn, dy = w.endYIn - w.startYIn, L = Math.hypot(dx, dy); if (L < 1) return null;
  const ux = dx / L, uy = dy / L;
  const xs = walls.flatMap((x) => [x.startXIn, x.endXIn]), ys = walls.flatMap((x) => [x.startYIn, x.endYIn]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  let nx = -uy, ny = ux; const o = clamp(offsetIn, 0, L);
  const mx = w.startXIn + ux * o, my = w.startYIn + uy * o;
  if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
  return { xIn: Math.round(mx + nx * (depthIn / 2)), yIn: Math.round(my + ny * (depthIn / 2)), rotationDeg: (Math.round((Math.atan2(nx, -ny) * 180) / Math.PI) + 360) % 360 };
}
/** The closed wall nearest a room point (inches), and the offset along it, keeping a piece of width wIn on the wall. */
export function nearestWall(walls, xIn, yIn, wIn = 0) {
  let best = null;
  for (const w of walls) {
    if (w.isOpen) continue;
    const dx = w.endXIn - w.startXIn, dy = w.endYIn - w.startYIn, L = Math.hypot(dx, dy); if (L < 1) continue;
    const t = clamp(((xIn - w.startXIn) * dx + (yIn - w.startYIn) * dy) / L, Math.min(wIn / 2, L / 2), Math.max(L - wIn / 2, L / 2));
    const px = w.startXIn + (dx / L) * t, py = w.startYIn + (dy / L) * t, dist = Math.hypot(xIn - px, yIn - py);
    if (!best || dist < best.dist) best = { wall: w, offsetIn: t, dist };
  }
  return best;
}

// ---- builders ----------------------------------------------------------------
// (g, w, d, h, p, ctx): p = params over defaults (strings); ctx = { ceil (ft), seed, light(x, y, z, color, weight) }.
function pendantAt(g, x, cy, r, sh, p, ctx, weight) {
  const lit = truthy(p.lit), k = kColor(p);
  const s = mesh(shadeGeo(p.shape, r, sh), shadeMat(p.material, k, lit)); s.position.set(x, cy, 0); g.add(s);
  if (p.shape === 'ufo_paper') { const ring = mesh(new THREE.TorusGeometry(r * 0.98, 0.012, 4, 24), mat('#e9e1d2')); ring.rotation.x = Math.PI / 2; ring.position.set(x, cy, 0); g.add(ring); }
  g.add(bulb(k, lit, Math.min(0.12, r * 0.35), x, cy - (p.shape === 'globe' || p.shape === 'ufo_paper' ? 0 : sh * 0.2), 0));
  if (lit && weight) ctx.light(x, cy - sh * 0.3, 0, k, weight);
  return s;
}
const ceilingTop = (ctx) => ctx.ceil ?? 8;

export const DECOR = {
  // ---------- Lighting ----------
  pendant(g, w, d, h, p, ctx) {
    const top = ceilingTop(ctx), r = Math.max(w, 0.4) / 2, sh = p.shape === 'ufo_paper' ? r * 0.84 : Math.max(h, 0.3);
    const cy = Math.max(top - ft(num(p.dropIn, 30)) - sh / 2, sh / 2 + 1);
    const met = metalM(p.metalFinish);
    g.add(cyl(0.2, 0.2, 0.05, met, 0, top - 0.05, 0));
    g.add(cyl(0.012, 0.012, top - (cy + sh / 2), mat('#222'), 0, cy + sh / 2, 0, 6));
    pendantAt(g, 0, cy, r, sh, p, ctx, 3);
  },
  swag_pendants(g, w, d, h, p, ctx) {
    const top = ceilingTop(ctx), n = clamp(Math.round(num(p.count, 3)), 1, 5), cell = w / n;
    const r = Math.min(cell * 0.42, d * 0.42, 0.75), sh = p.shape === 'ufo_paper' ? r * 0.84 : Math.min(Math.max(h, 0.3), r * 2);
    const cord = mat({ black: '#1d1d1d', white: '#efece6', natural: '#c9a978' }[p.cord] ?? '#1d1d1d');
    const steps = [0, 2, 1, 2, 0], drop = ft(num(p.dropIn, 40)), step = ft(num(p.dropStepIn, 8));
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + cell * (i + 0.5), cy = Math.max(top - drop - steps[i] * step - sh / 2, sh / 2 + 1);
      g.add(sph(0.04, mat('#c9a978', { metalness: 0.6 }), x, top - 0.04, 0, 6, 4));
      g.add(rod([x, top - 0.05, 0], [x, cy + sh / 2, 0], 0.012, cord));
      // the swag: from the hook, sagging back to the wall and down to the outlet
      g.add(tube([[x, top - 0.06, 0], [x * 0.6 + w / 2 * 0.4, top - 0.7, -d / 4], [w / 2, top - 0.35, -d / 2]], 0.012, cord, 16));
      pendantAt(g, x, cy, r, sh, p, ctx, i === Math.floor(n / 2) ? 3 : 0);
    }
    g.add(rod([w / 2, top - 0.35, -d / 2], [w / 2, 1.0, -d / 2], 0.012, cord));
  },
  wall_sconce(g, w, d, h, p, ctx) {
    const lit = truthy(p.lit), k = kColor(p), cy = ft(num(p.mountHeightIn, 66)), met = metalM(p.metalFinish);
    const r = Math.max(w, 0.3) / 2 * 0.95, sh = Math.max(h, 0.35) * 0.6, z = -d / 2 + Math.max(d - r, r);
    g.add(box(0.28, 0.42, 0.04, met, 0, cy - 0.21, -d / 2 + 0.02));
    if (p.style === 'plate') {
      const disc = mesh(new THREE.CylinderGeometry(r, r, 0.08, 24), shadeMat(p.shadeMaterial, k, lit, METAL[p.metalFinish])); disc.rotation.x = Math.PI / 2; disc.position.set(0, cy, -d / 2 + 0.1); g.add(disc);
    } else {
      g.add(box(0.05, 0.05, Math.max(z + d / 2, 0.05), met, 0, cy - 0.025, (z - d / 2) / 2));
      const shp = p.style === 'dome' ? 'dome' : p.style === 'cylinder' ? 'drum' : 'globe';
      const s = mesh(shadeGeo(shp, r, sh), shadeMat(p.shadeMaterial, k, lit, METAL[p.metalFinish])); s.position.set(0, cy + (shp === 'dome' ? sh * 0.6 : 0), z); g.add(s);
      g.add(bulb(k, lit, 0.07, 0, cy, z));
    }
    if (truthy(p.plugIn)) g.add(rod([0, cy - 0.2, -d / 2 + 0.03], [0, 0.05, -d / 2 + 0.03], 0.012, mat('#1d1d1d')));
    if (lit) { const hl = halo(2.2, 3, k, 'radial', 0.45); hl.position.set(0, cy, -d / 2 + 0.01); g.add(hl); ctx.light(0, cy, z + 0.3, k, 2); }
  },
  swing_arm_lamp(g, w, d, h, p, ctx) {
    const lit = truthy(p.lit), k = kColor(p), cy = ft(num(p.mountHeightIn, 60)), met = metalM(p.metalFinish);
    const L = clamp(ft(num(p.armLengthIn, 20)), 0.5, Math.max(d - 0.35, 0.5)), r = Math.max(w, 0.4) / 2 * 0.95, sh = Math.max(h, 0.4) * 0.7;
    g.add(box(0.22, 0.4, 0.04, met, 0, cy - 0.2, -d / 2 + 0.02));
    g.add(rod([0, cy, -d / 2 + 0.04], [0, cy + 0.08, -d / 2 + L], 0.02, met));
    g.add(sph(0.04, met, 0, cy, -d / 2 + 0.04, 8, 6));
    const zx = -d / 2 + L, shp = p.shadeShape === 'drum' ? 'drum' : p.shadeShape === 'dome' ? 'dome' : 'cone';
    const s = mesh(shadeGeo(shp, r, sh), mat(p.shadeColor || '#2f4a3a', { side: THREE.DoubleSide, roughness: 0.6, metalness: 0.2 })); s.position.set(0, cy + 0.02, zx); g.add(s);
    g.add(bulb(k, lit, 0.07, 0, cy - sh * 0.25, zx));
    if (lit) { const pool = halo(1.2, 1.2, k, 'radial', 0.35); pool.rotation.x = -Math.PI / 2; pool.position.set(0, cy - sh / 2 - 0.02, zx); g.add(pool); ctx.light(0, cy - sh / 2, zx, k, 2); }
  },
  table_lamp(g, w, d, h, p, ctx) {
    const lit = truthy(p.lit), k = kColor(p), r = Math.max(Math.min(w, d), 0.5) / 2, baseH = h * 0.55, sh = h * 0.4;
    const bc = p.baseColor || '#c9b79c';
    if (p.base === 'brass' || p.base === 'wood') {
      const m = p.base === 'brass' ? metalM('brass') : mat(bc, { roughness: 0.55 });
      g.add(cyl(r * 0.55, r * 0.6, 0.06, m)); g.add(cyl(p.base === 'wood' ? r * 0.25 : 0.035, p.base === 'wood' ? r * 0.32 : 0.035, baseH, m, 0, 0.06));
    } else if (p.base === 'glass') {
      g.add(sph(r * 0.55, new THREE.MeshStandardMaterial({ color: bc, transparent: true, opacity: 0.55, roughness: 0.05 }), 0, baseH * 0.45, 0, 18, 12));
    } else { // ceramic or clay: a ginger-jar lathe
      const pts = [[0, 0], [0.5, 0], [0.62, 0.1], [0.68, 0.45], [0.55, 0.78], [0.2, 0.92], [0.16, 1]].map(([x, y]) => new THREE.Vector2(x * r, y * baseH));
      g.add(mesh(new THREE.LatheGeometry(pts, 20), mat(bc, { roughness: p.base === 'clay' ? 1 : 0.3 })));
    }
    g.add(cyl(0.015, 0.015, sh * 0.6, mat('#9a8a70', { metalness: 0.6 }), 0, baseH));
    const s = mesh(shadeGeo(p.shade === 'mushroom' ? 'mushroom' : p.shade, r, sh), shadeMat('fabric', k, lit, p.shadeColor)); s.position.set(0, baseH + sh * 0.5 + 0.03, 0); g.add(s);
    g.add(bulb(k, lit, 0.06, 0, baseH + sh * 0.35, 0));
    if (lit) ctx.light(0, baseH + sh * 0.4, 0, k, 2);
  },
  floor_lamp(g, w, d, h, p, ctx) {
    const lit = truthy(p.lit ?? true), k = kColor(p), met = metalM(p.metalFinish), r = Math.max(w, 0.8) / 2;
    const style = p.shadeStyle ?? 'drum', sh = style === 'globe' ? r * 1.2 : 1.0;
    g.add(cyl(r * 0.8, r * 0.9, 0.08, met));
    const sm = shadeMat(style === 'globe' ? 'glass' : 'fabric', k, lit, p.shadeColor || '#efe7d8');
    let sx = 0, sy, sz = 0;
    if (truthy(p.arc)) {
      sz = d / 2 + 2.5; sy = h * 0.85 - sh / 2 - 0.1;
      g.add(tube([[0, 0, 0], [0, h * 0.75, 0.3], [0, h * 1.02, sz * 0.55], [0, h * 0.86, sz]], 0.03, met, 32));
      const s = style === 'drum' || style === 'pleated' || style === 'cone'
        ? mesh(shadeGeo(style === 'cone' ? 'cone' : 'dome', 0.6, 0.5), sm) : mesh(shadeGeo('globe', 0.45, 0.9), sm);
      s.position.set(sx, sy, sz); g.add(s);
    } else {
      sy = h - sh / 2;
      g.add(cyl(0.03, 0.03, h - sh * 0.6, met, 0, 0.08));
      const s = mesh(shadeGeo(style, style === 'globe' ? 0.5 : r * 0.95, sh), sm); s.position.set(0, sy, 0); g.add(s);
    }
    g.add(bulb(k, lit, 0.08, sx, sy - 0.1, sz));
    if (lit) ctx.light(sx, sy - 0.2, sz, k, 2);
  },
  led_strip(g, w, d, h, p, ctx) {
    const lit = truthy(p.lit), k = kColor(p), place = p.placement ?? 'cove';
    const y = place === 'floor' ? 0.12 : Math.min(ft(num(p.mountHeightIn, 96)), ceilingTop(ctx) - 0.1);
    g.add(box(w, 0.04, 0.08, new THREE.MeshBasicMaterial({ color: lit ? k : '#9a958e' }), 0, y, -d / 2 + 0.06));
    if (place === 'cove') g.add(box(w, 0.06, 0.35, mat('#efece6'), 0, y - 0.06, -d / 2 + 0.175)); // the cove lip
    if (!lit) return;
    const kind = place === 'shelf' ? 'down' : place === 'behind_tv' ? 'radial' : 'up';
    const hh = place === 'behind_tv' ? 4 : place === 'cove' ? Math.min(1.6, ceilingTop(ctx) - y + 0.4) : 2.4;
    const hl = halo(place === 'behind_tv' ? w * 1.4 : w, hh, k, kind, place === 'behind_tv' ? 0.9 : 0.6);
    hl.position.set(0, kind === 'up' ? y + hh / 2 : kind === 'down' ? y - hh / 2 : y, -d / 2 + 0.01); g.add(hl);
    ctx.light(0, y + (kind === 'down' ? -0.4 : 0.4), -d / 2 + 0.5, k, 1);
  },
  ceiling_fan(g, w, d, h, p, ctx) {
    const top = ceilingTop(ctx), met = metalM(p.metalFinish ?? 'black'), n = clamp(Math.round(num(p.bladeCount, 5)), 3, 8);
    const motorY = top - ft(num(p.dropIn, 6)) - 0.35, R = Math.max(w, 2) / 2;
    g.add(cyl(0.22, 0.25, 0.12, met, 0, top - 0.12, 0, 16));
    g.add(cyl(0.03, 0.03, top - 0.12 - (motorY + 0.35), met, 0, motorY + 0.35, 0, 8));
    g.add(cyl(0.3, 0.35, 0.35, met, 0, motorY, 0, 18));
    const fin = p.bladeFinish ?? 'walnut';
    const bm = fin === 'rattan' ? mat('#ffffff', { map: weaveTex(), roughness: 1 }) : mat(WOOD[fin] ?? { black: '#1d1d1d', white: '#efece6' }[fin] ?? WOOD.walnut, { roughness: 0.6 });
    for (let i = 0; i < n; i++) {
      const piv = new THREE.Group(); piv.position.y = motorY + 0.12; piv.rotation.y = (i * 2 * Math.PI) / n;
      const L = R - 0.3, b = box(L, 0.025, 0.45, bm, 0.3 + L / 2, 0, 0); b.rotation.x = 0.12; piv.add(b);
      piv.add(box(0.35, 0.03, 0.08, met, 0.3, -0.01, 0)); g.add(piv);
    }
    if (truthy(p.lightKit)) {
      const lit = truthy(p.lit), k = KELVIN[2700];
      const bowl = mesh(new THREE.SphereGeometry(0.3, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), shadeMat('glass', k, lit)); bowl.position.y = motorY; g.add(bowl);
      if (lit) ctx.light(0, motorY - 0.3, 0, k, 2);
    }
  },

  // ---------- Wall decor ----------
  framed_art(g, w, d, h, p, ctx) {
    const cy = Math.max(ft(num(p.mountHeightIn, 57)), h / 2), y0 = cy - h / 2, z = -d / 2;
    const style = p.frameStyle ?? 'thin', frame = mat(p.frameColor || '#1d1d1d', { roughness: 0.5 });
    const art = mat('#ffffff', { map: artTex(p.artStyle ?? 'abstract', p.artColor || '#b5835a', ctx.seed ?? 1), roughness: 0.9 });
    const face = (x, y, ww, hh, m, zz) => { const o = mesh(new THREE.PlaneGeometry(ww, hh), m, x, y, zz); g.add(o); return o; };
    if (style === 'canvas') { g.add(box(w, h, d, mat(shade(p.artColor || '#b5835a', -0.2)), 0, y0, 0)); face(0, cy, w, h, art, d / 2 + 0.003); return; }
    if (style === 'floating') { g.add(box(w, h, d * 0.6, frame, 0, y0, z + d * 0.3)); g.add(box(w - 0.12, h - 0.12, d * 0.4, mat('#f2ede4'), 0, y0 + 0.06, z + d * 0.75)); face(0, cy, w - 0.2, h - 0.2, art, d / 2 + 0.004); return; }
    g.add(box(w, h, d, frame, 0, y0, 0));
    const f = 0.07;
    if (style === 'mat') { face(0, cy, w - 2 * f, h - 2 * f, mat('#f7f3ea', { roughness: 1 }), d / 2 + 0.002); face(0, cy, (w - 2 * f) * 0.66, (h - 2 * f) * 0.7, art, d / 2 + 0.004); }
    else face(0, cy, w - 2 * f, h - 2 * f, art, d / 2 + 0.003);
  },
  gallery_wall(g, w, d, h, p, ctx) {
    const rows = clamp(Math.round(num(p.rows, 2)), 1, 6), cols = clamp(Math.round(num(p.cols, 3)), 1, 8), gap = ft(num(p.gapIn, 3));
    const cw = (w - gap * (cols - 1)) / cols, ch = (h - gap * (rows - 1)) / rows, cy = Math.max(ft(num(p.mountHeightIn, 57)), h / 2);
    const styles = ['abstract', 'botanical', 'line', 'landscape', 'photo'];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c, x = -w / 2 + cw / 2 + c * (cw + gap), y = cy + h / 2 - ch / 2 - r * (ch + gap);
      // vary sizes a little so it reads as a gallery
      const sw = cw * (i % 3 === 1 ? 0.85 : 1), shh = ch * (i % 2 ? 0.9 : 1);
      const sub = new THREE.Group(); sub.position.set(x, 0, 0);
      DECOR.framed_art(sub, sw, d, shh, { frameColor: p.frameColor, frameStyle: truthy(p.mat ?? true) ? 'mat' : 'thin', artStyle: styles[i % styles.length], artColor: p.artColor, mountHeightIn: y * 12 }, { ...ctx, seed: (ctx.seed ?? 1) + i });
      g.add(sub);
    }
  },
  wall_disk(g, w, d, h, p) {
    const r = Math.max(w, 0.5) / 2, cy = Math.max(ft(num(p.mountHeightIn, 60)), r), col = p.color || '#2b2a28', tx = p.texture ?? 'plaster';
    const face = tx === 'woven' ? mat('#ffffff', { map: weaveTex(col), roughness: 1 }) : tx === 'metal' ? mat(col, { metalness: 0.8, roughness: 0.35, map: noiseTex('#ffffff', 'm') })
      : tx === 'wood' ? mat(col, { roughness: 0.6, map: canvasTex(`rings${col}`, 128, 128, (gg, W) => { gg.fillStyle = '#fff'; gg.fillRect(0, 0, W, W); gg.strokeStyle = 'rgba(0,0,0,0.25)'; for (let i = 4; i < W / 2; i += 5) { gg.lineWidth = 1 + (i % 3); gg.beginPath(); gg.arc(W / 2, W / 2, i, 0, 7); gg.stroke(); } }) })
      : mat(col, { roughness: 1, map: noiseTex('#ffffff', 'p') });
    const side = mat(shade(col, -0.15), { roughness: 0.9 });
    const m = mesh(new THREE.CylinderGeometry(r, r, Math.max(d, 0.08), 40), [side, face, side]); m.rotation.x = Math.PI / 2; m.position.set(0, cy, 0); g.add(m);
  },
  mirror(g, w, d, h, p) {
    const lean = truthy(p.lean), cy = lean ? h / 2 : Math.max(ft(num(p.mountHeightIn, 60)), h / 2);
    const outline = (s, ww, hh) => { // shape centered at 0,0
      const shp = new THREE.Shape(), r = ww / 2;
      if (s === 'round') shp.absarc(0, 0, Math.min(ww, hh) / 2, 0, Math.PI * 2, false);
      else if (s === 'arch') { shp.moveTo(-r, -hh / 2); shp.lineTo(r, -hh / 2); shp.lineTo(r, hh / 2 - r); shp.absarc(0, hh / 2 - r, r, 0, Math.PI, false); shp.lineTo(-r, -hh / 2); }
      else if (s === 'organic') { const n = 24; for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2, k = 1 + 0.08 * Math.sin(a * 3 + 1) + 0.05 * Math.cos(a * 2); const x = Math.cos(a) * r * k, y = Math.sin(a) * (hh / 2) * k; i ? shp.lineTo(x, y) : shp.moveTo(x, y); } }
      else { shp.moveTo(-r, -hh / 2); shp.lineTo(r, -hh / 2); shp.lineTo(r, hh / 2); shp.lineTo(-r, hh / 2); shp.lineTo(-r, -hh / 2); }
      return shp;
    };
    const s = p.shape ?? 'arch', grp = new THREE.Group();
    const fr = p.frame ?? 'brass', fd = Math.max(d, 0.08);
    if (fr !== 'none') {
      const fm = fr === 'wood' ? woodM('oak') : fr === 'black' ? mat('#1d1d1d', { roughness: 0.4 }) : metalM('brass');
      const geo = new THREE.ExtrudeGeometry(outline(s, w, h), { depth: fd, bevelEnabled: false, curveSegments: 20 });
      const fm2 = mesh(geo, fm, 0, 0, -fd / 2); grp.add(fm2);
    }
    const inset = fr === 'none' ? 1 : 0.9;
    const glass = mesh(new THREE.ShapeGeometry(outline(s, w * inset, h - w * (1 - inset)), 20), new THREE.MeshStandardMaterial({ color: '#c7d3d8', metalness: 0.25, roughness: 0.04, emissive: '#2c3438', emissiveIntensity: 0.6 }), 0, 0, fd / 2 + 0.004);
    grp.add(glass);
    grp.position.set(0, cy, 0);
    if (lean) { grp.rotation.x = -0.1; grp.position.z = Math.min(h * 0.05, 0.4); grp.position.y = cy + 0.02; }
    g.add(grp);
  },
  wall_paneling(g, w, d, h, p, ctx) {
    const y0 = ft(num(p.bottomIn, 0)), style = p.style ?? 'slats', z = -d / 2;
    const col = p.material === 'painted' ? p.paintColor || '#2f3a33' : WOOD[p.material] ?? WOOD.walnut;
    const m = mat(col, { roughness: 0.6 });
    const inst = (geo, n, place) => { const im = new THREE.InstancedMesh(geo, m, n), M = new THREE.Matrix4(); for (let i = 0; i < n; i++) { place(M, i); im.setMatrixAt(i, M); } im.castShadow = true; im.receiveShadow = true; g.add(im); };
    let topY = y0 + h;
    if (style === 'slats' || style === 'fluted') {
      const sw = Math.max(ft(num(p.slatWidthIn, 2)), 0.05), gap = ft(num(p.gapIn, 1)), n = Math.max(1, Math.floor((w + gap) / (sw + gap))), used = n * sw + (n - 1) * gap;
      if (style === 'slats') { g.add(box(w, h, 0.03, mat('#1f1b18', { roughness: 1 }), 0, y0, z + 0.015)); inst(new THREE.BoxGeometry(sw, h, d * 0.7), n, (M, i) => M.makeTranslation(-used / 2 + sw / 2 + i * (sw + gap), y0 + h / 2, z + 0.03 + d * 0.35)); }
      else { g.add(box(w, h, 0.04, m, 0, y0, z + 0.02)); const geo = new THREE.CylinderGeometry(sw / 2, sw / 2, h, 8, 1, false, -Math.PI / 2, Math.PI); inst(geo, n, (M, i) => M.makeTranslation(-used / 2 + sw / 2 + i * (sw + gap), y0 + h / 2, z + 0.04)); }
    } else if (style === 'wainscot') {
      g.add(box(w, h, 0.05, m, 0, y0, z + 0.025));
      const rail = 0.3, n = Math.max(1, Math.round(w / 2.5)), pw = w / n;
      g.add(box(w, rail, 0.09, m, 0, y0, z + 0.045)); g.add(box(w, rail, 0.09, m, 0, y0 + h - rail, z + 0.045));
      for (let i = 0; i <= n; i++) g.add(box(0.25, h, 0.09, m, -w / 2 + i * pw, y0, z + 0.045));
      const panel = mat(shade(col, 0.06), { roughness: 0.6 });
      for (let i = 0; i < n; i++) g.add(box(pw - 0.55, h - 2 * rail - 0.25, 0.07, panel, -w / 2 + (i + 0.5) * pw, y0 + rail + 0.12, z + 0.035));
    } else { // board and batten
      g.add(box(w, h, 0.04, m, 0, y0, z + 0.02));
      const n = Math.max(1, Math.round(w / 1.33));
      for (let i = 0; i <= n; i++) g.add(box(0.25, h, 0.08, m, clamp(-w / 2 + i * (w / n), -w / 2 + 0.125, w / 2 - 0.125), y0, z + 0.04));
      g.add(box(w, 0.4, 0.09, m, 0, y0 + h - 0.4, z + 0.045));
    }
    if (truthy(p.ledge) && style !== 'fluted') { g.add(box(w + 0.1, 0.07, 0.3, m, 0, topY, z + 0.15)); topY += 0.07; }
    if (truthy(p.ledLit)) {
      const k = KELVIN[2700]; g.add(box(w, 0.03, 0.04, new THREE.MeshBasicMaterial({ color: k }), 0, topY, z + 0.06));
      const hl = halo(w, 2, k, 'up', 0.55); hl.position.set(0, topY + 1, z + 0.012); g.add(hl); ctx.light(0, topY + 0.4, z + 0.6, k, 1);
    }
  },
  lit_niche(g, w, d, h, p, ctx) {
    const y0 = ft(num(p.bottomIn, 30)), lit = truthy(p.lit), k = kColor(p), z = -d / 2, style = p.style ?? 'niche';
    const fm = mat(p.frameColor || '#efece6', { roughness: 0.8 }), im = mat(p.interiorColor || '#3a2f28', { roughness: 0.9, emissive: k, emissiveIntensity: lit ? 0.18 : 0 });
    const t = style === 'shelves' ? 0.12 : 0.35, iw = w - 2 * t, ih = h - 2 * t;
    const outer = new THREE.Shape(); outer.moveTo(-w / 2, 0); outer.lineTo(w / 2, 0); outer.lineTo(w / 2, h); outer.lineTo(-w / 2, h); outer.lineTo(-w / 2, 0);
    const hole = new THREE.Path();
    if (style === 'arched_niche') { const r = iw / 2; hole.moveTo(-r, t); hole.lineTo(r, t); hole.lineTo(r, h - t - r); hole.absarc(0, h - t - r, r, 0, Math.PI, false); hole.lineTo(-r, t); }
    else { hole.moveTo(-iw / 2, t); hole.lineTo(iw / 2, t); hole.lineTo(iw / 2, h - t); hole.lineTo(-iw / 2, h - t); hole.lineTo(-iw / 2, t); }
    outer.holes.push(hole);
    g.add(mesh(new THREE.ExtrudeGeometry(outer, { depth: d, bevelEnabled: false, curveSegments: 18 }), fm, 0, y0, z));
    g.add(box(iw, ih, 0.04, im, 0, y0 + t, z + 0.02));
    const n = clamp(Math.round(num(p.shelfCount, 2)), 0, 8), shelfM = mat(p.frameColor || '#efece6', { roughness: 0.7 }), vase = [mat('#d9cbb2', { roughness: 0.4 }), mat('#2b2a28'), mat('#a8622f', { roughness: 0.9 })];
    const usableH = style === 'arched_niche' ? ih - iw / 2 : ih;
    for (let i = 0; i <= n; i++) {
      const y = y0 + t + (i * usableH) / (n + 1);
      if (i) g.add(box(iw, 0.06, d - 0.05, shelfM, 0, y, z + d / 2));
      const top = y + (i ? 0.06 : 0);
      g.add(cyl(0.12, 0.09, Math.min(0.55, usableH / (n + 1) * 0.6), vase[i % 3], -iw * 0.22, top, z + d / 2));
      g.add(box(iw * 0.25, Math.min(0.5, usableH / (n + 1) * 0.5), d * 0.5, vase[(i + 1) % 3], iw * 0.2, top, z + d / 2));
    }
    if (lit) {
      g.add(box(iw * 0.9, 0.03, 0.05, new THREE.MeshBasicMaterial({ color: k }), 0, y0 + h - t - (style === 'arched_niche' ? iw / 2 * 0.3 : 0.05), z + 0.1));
      const hl = halo(iw * 1.1, ih, k, 'down', 0.5); hl.position.set(0, y0 + t + ih / 2, z + 0.05); g.add(hl);
      ctx.light(0, y0 + h - t - 0.3, z + d + 0.3, k, 2);
    }
  },

  // ---------- Soft goods and plants ----------
  curtains(g, w, d, h, p, ctx) {
    const rodY = Math.min(ft(num(p.rodHeightIn, 96)), ceilingTop(ctx) - 0.05), L = Math.min(ft(num(p.lengthIn, 95)), rodY), z = -d / 2 + 0.22;
    const fin = metalM(p.rodFinish ?? 'black');
    g.add(rod([-w / 2 - 0.3, rodY, z], [w / 2 + 0.3, rodY, z], 0.04, fin, 8));
    for (const s of [-1, 1]) { g.add(sph(0.08, fin, s * (w / 2 + 0.33), rodY, z, 8, 6)); g.add(box(0.05, 0.05, 0.22, fin, s * (w / 2 + 0.1), rodY - 0.025, z - 0.11)); }
    const full = num(p.fullness, 2), open = clamp(num(p.openPercent, 60), 0, 100) / 100, op = p.opacity ?? 'sheer';
    const cm = mat(p.color || '#ebe3d3', { side: THREE.DoubleSide, roughness: 1, transparent: op !== 'blackout', opacity: op === 'sheer' ? 0.45 : op === 'light_filtering' ? 0.85 : 1, depthWrite: op !== 'sheer' });
    const panel = (x0, pw) => {
      const folds = Math.max(3, Math.round((pw * full) / 0.45)), geo = new THREE.PlaneGeometry(pw, L, folds * 6, 1), pos = geo.attributes.position, amp = 0.05 + 0.03 * full;
      for (let i = 0; i < pos.count; i++) { const u = (pos.getX(i) + pw / 2) / pw; pos.setZ(i, Math.sin(u * folds * Math.PI * 2) * amp); }
      geo.computeVertexNormals();
      const m = mesh(geo, cm, x0 + pw / 2, rodY - 0.08 - L / 2, z + 0.05); m.castShadow = op !== 'sheer'; g.add(m);
    };
    const minW = Math.max(w * 0.1, 0.5);
    if (p.panels === 'single') panel(-w / 2 - 0.25, Math.max((w + 0.5) * (1 - open), minW));
    else { const pw = Math.max(((w + 0.5) / 2) * (1 - open), minW); panel(-w / 2 - 0.25, pw); panel(w / 2 + 0.25 - pw, pw); }
  },
  plant(g, w, d, h, p, ctx) {
    const r0 = rng((ctx.seed ?? 1) * 31 + 7), type = p.type ?? 'fiddle_leaf';
    const potH = clamp(ft(num(p.potHeightIn, 14)), 0.2, h * 0.7), pr = Math.max(Math.min(w, d), 0.4) / 2 * (type === 'pothos' || type === 'snake_plant' ? 0.75 : 0.55);
    const potCol = { terracotta: '#b5653a', white_ceramic: '#eeebe5', black_ceramic: '#222120', concrete: '#9a9893' }[p.pot] ?? '#b5653a';
    const pm = p.pot === 'basket' ? mat('#ffffff', { map: weaveTex('#c9a26e'), roughness: 1 }) : mat(potCol, { roughness: p.pot?.includes('ceramic') ? 0.35 : 0.95 });
    g.add(cyl(pr, pr * (p.pot === 'terracotta' ? 0.75 : 0.88), potH, pm, 0, 0, 0, 18));
    if (p.pot === 'terracotta') g.add(cyl(pr * 1.08, pr * 1.08, potH * 0.14, pm, 0, potH * 0.86, 0, 18));
    g.add(cyl(pr * 0.93, pr * 0.93, 0.02, mat('#3b2a1e', { roughness: 1 }), 0, potH - 0.04, 0, 14));
    const H = Math.max(h - potH, 0.3), base = potH;
    const green = { fiddle_leaf: '#2f5a2a', bird_of_paradise: '#3f6e3c', olive_tree: '#8a9a6c', pothos: '#4e8a3a', snake_plant: '#3c5a33', monstera: '#2c5a2c' }[type] ?? '#3d6b3a';
    const lm = mat(green, { roughness: 0.7, side: THREE.DoubleSide, flatShading: true }), stem = mat('#6b5a3a', { roughness: 0.9 });
    const leaves = (geo, n, place, m = lm) => { const im = new THREE.InstancedMesh(geo, m, n), M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), v = new THREE.Vector3(); for (let i = 0; i < n; i++) { place(i, v, e, s); M.compose(v, q.setFromEuler(e), s); im.setMatrixAt(i, M); } im.castShadow = true; g.add(im); };
    const spread = Math.max(w, d) / 2;
    if (type === 'fiddle_leaf') {
      g.add(cyl(0.035, 0.05, H * 0.9, stem, 0, base, 0, 6));
      leaves(new THREE.SphereGeometry(1, 6, 4), 26, (i, v, e, s) => { const t = 0.3 + 0.7 * (i / 26), a = i * 2.4; const rr = spread * (0.35 + 0.3 * r0()) * (1 - 0.4 * t); v.set(Math.cos(a) * rr, base + H * t, Math.sin(a) * rr); e.set(0.4 * r0() - 0.2, -a, 0.9 + 0.4 * r0()); s.set(0.32, 0.45, 0.05); });
    } else if (type === 'bird_of_paradise') {
      leaves(new THREE.SphereGeometry(1, 6, 6), 9, (i, v, e, s) => { const a = i * 0.7 + r0(), t = 0.65 + 0.35 * r0(), tilt = 0.15 + 0.25 * r0(); v.set(Math.sin(tilt) * Math.cos(a) * H * 0.6, base + H * t - 0.6, Math.sin(tilt) * Math.sin(a) * H * 0.6); e.set(Math.sin(a) * tilt * 1.4, 0, -Math.cos(a) * tilt * 1.4); s.set(0.28, 0.75, 0.04); });
      for (let i = 0; i < 9; i++) { const a = i * 0.7, tilt = 0.25; g.add(rod([0, base, 0], [Math.sin(tilt) * Math.cos(a) * H * 0.45, base + H * 0.55, Math.sin(tilt) * Math.sin(a) * H * 0.45], 0.02, mat('#5c7a45'), 5)); }
    } else if (type === 'olive_tree') {
      g.add(tube([[0, base, 0], [0.08, base + H * 0.25, 0.04], [-0.05, base + H * 0.45, -0.02], [0.02, base + H * 0.6, 0]], 0.05, mat('#6b5e4c', { roughness: 1 }), 12));
      leaves(new THREE.IcosahedronGeometry(1, 0), 16, (i, v, e, s) => { const a = i * 2.39, rr = spread * 0.75 * Math.sqrt(r0()); v.set(Math.cos(a) * rr, base + H * (0.62 + 0.3 * r0()), Math.sin(a) * rr); e.set(r0() * 3, r0() * 3, 0); const k = 0.28 + 0.22 * r0(); s.set(k, k * 0.8, k); });
    } else if (type === 'pothos') {
      leaves(new THREE.SphereGeometry(1, 6, 4), 18, (i, v, e, s) => { const a = i * 2.4, rr = pr * 0.9 * r0(); v.set(Math.cos(a) * rr, base + 0.1 + 0.25 * r0(), Math.sin(a) * rr); e.set(r0(), -a, 1.2); s.set(0.16, 0.2, 0.04); });
      const vines = [];
      for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + 0.3, len = H * (0.4 + 0.6 * r0()); const pts = [[Math.cos(a) * pr * 0.8, base + 0.1, Math.sin(a) * pr * 0.8], [Math.cos(a) * pr * 1.25, base - len * 0.35, Math.sin(a) * pr * 1.25], [Math.cos(a) * pr * 1.4, Math.max(base - len, 0.05), Math.sin(a) * pr * 1.4]]; vines.push(pts); g.add(tube(pts, 0.012, mat('#5f8a3c'), 10)); }
      leaves(new THREE.SphereGeometry(1, 5, 3), 36, (i, v, e, s) => { const pts = vines[i % 6], t = Math.floor(i / 6) / 6, A = pts[0], B = pts[2]; v.set(A[0] + (B[0] - A[0]) * t * 1.05, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t * 1.05); e.set(r0(), r0() * 6, 1.3); s.set(0.1, 0.13, 0.03); }, mat('#6a9c3f', { roughness: 0.7, flatShading: true }));
    } else if (type === 'snake_plant') {
      leaves(new THREE.ConeGeometry(1, 1, 4), 11, (i, v, e, s) => { const a = i * 2.3, rr = pr * 0.55 * r0(), hh = H * (0.6 + 0.4 * r0()); v.set(Math.cos(a) * rr, base + hh / 2, Math.sin(a) * rr); e.set((r0() - 0.5) * 0.25, a, (r0() - 0.5) * 0.25); s.set(0.12, hh, 0.03); });
    } else { // monstera
      leaves(new THREE.CircleGeometry(1, 9), 10, (i, v, e, s) => { const a = i * 2.5, rr = spread * (0.45 + 0.4 * r0()), y = base + H * (0.45 + 0.5 * r0()); v.set(Math.cos(a) * rr, y, Math.sin(a) * rr); e.set(-Math.PI / 2 + 0.5, -a + Math.PI / 2, 0, 'YXZ'); s.set(0.5, 0.42, 1); });
      for (let i = 0; i < 10; i++) { const a = i * 2.5; g.add(rod([0, base, 0], [Math.cos(a) * spread * 0.5, base + H * 0.6, Math.sin(a) * spread * 0.5], 0.015, mat('#4f7a3a'), 4)); }
    }
  },
  pillows(g, w, d, h, p, ctx) {
    const n = clamp(Math.round(num(p.count, 3)), 1, 8), s = Math.min(ft(num(p.sizeIn, 20)), w / n), tex = p.texture ?? 'linen';
    const mk = (c) => mat(c, { roughness: tex === 'velvet' ? 0.5 : 1, map: tex === 'boucle' ? noiseTex('#ffffff', 'b') : tex === 'knit' ? weaveTex('#ffffff') : null });
    const a = mk(p.color || '#b5835a'), b = truthy(p.alternate ?? true) ? mk(p.accentColor || '#2f3a33') : a;
    const total = n * s * 0.92;
    for (let i = 0; i < n; i++) {
      const o = mesh(new THREE.SphereGeometry(0.5, 14, 10), i % 2 ? b : a);
      o.scale.set(s, s * 0.95, s * 0.32); o.rotation.x = -0.28; o.rotation.z = (i - (n - 1) / 2) * 0.04;
      o.position.set(-total / 2 + s * 0.46 + i * s * 0.92, s * 0.44, -d / 2 + s * 0.16); g.add(o);
    }
  },
  throw_blanket(g, w, d, h, p) {
    const tex = p.texture ?? 'knit', c = p.color || '#8a5a3c';
    const m = mat(tex === 'faux_fur' ? shade(c, 0.35) : c, { roughness: 1, map: tex === 'knit' ? weaveTex('#ffffff') : tex === 'faux_fur' ? noiseTex('#ffffff', 'f') : null });
    const t = tex === 'faux_fur' ? 0.08 : 0.05, style = p.style ?? 'draped_arm';
    if (style === 'folded_seat') { g.add(box(w * 0.55, t * 3, d * 0.9, m, 0, 0, 0)); }
    else if (style === 'over_back') { g.add(box(w * 0.8, t, 0.7, m, 0, 0, 0)); g.add(box(w * 0.8, 1.0, t, m, 0, -1.0, 0.35)); g.add(box(w * 0.8, 0.7, t, m, 0, -0.7, -0.35)); }
    else { const aw = 0.6; g.add(box(aw, t, d, m, 0, 0, 0)); g.add(box(t, 1.0, d, m, aw / 2, -1.0, 0)); g.add(box(t, 0.55, d * 0.95, m, -aw / 2, -0.55, 0)); }
    if (tex === 'fringe') for (const s of [-1, 1]) for (let i = 0; i < 10; i++) g.add(box(0.015, 0.012, 0.15, m, -w * 0.25 + (i * w * 0.5) / 9, 0, s * (d / 2 + 0.07)));
  },

  // ---------- Furniture ----------
  wood_frame_lounge_chair(g, w, d, h, p) {
    const wood = woodM(p.woodTone), fab = mat(p.fabricColor || '#5b5f66', { roughness: 0.95 });
    const seatY = 1.25, armY = 1.85, sx = w / 2 - 0.07, arms = p.arms ?? 'open_wood';
    for (const s of [-1, 1]) {
      const x = s * sx;
      g.add(box(0.12, arms === 'none' ? seatY : armY, 0.12, wood, x, 0, d / 2 - 0.12));
      g.add(rod([x, 0, -d / 2 + 0.15], [x, arms === 'none' ? seatY : armY - 0.05, -d / 2 + 0.45], 0.06, wood, 6));
      g.add(box(0.1, 0.1, d - 0.2, wood, x, seatY - 0.45, 0));
      if (arms !== 'none') g.add(box(0.16, 0.08, d - 0.1, wood, x, armY, 0.02));
      if (arms === 'slat') for (let i = 0; i < 4; i++) g.add(box(0.06, armY - seatY + 0.4, 0.05, wood, x, seatY - 0.4, -d / 2 + 0.5 + (i * (d - 0.8)) / 3));
    }
    g.add(box(w - 0.2, 0.09, 0.09, wood, 0, seatY - 0.4, d / 2 - 0.12));
    g.add(box(w - 0.32, 0.38, d * 0.72, fab, 0, seatY - 0.32, d * 0.08));
    const backH = p.backHeight === 'high' ? Math.max(h - seatY + 0.6, 1.8) : Math.max(h - seatY, 1.1);
    const piv = new THREE.Group(); piv.position.set(0, seatY, -d / 2 + 0.38); piv.rotation.x = -0.3;
    piv.add(box(w - 0.36, backH, 0.32, fab, 0, 0, 0));
    for (const s of [-1, 1]) piv.add(box(0.08, backH + 0.1, 0.08, wood, s * (w / 2 - 0.16), -0.05, -0.2));
    g.add(piv);
  },
  dining_chair(g, w, d, h, p) {
    const style = p.style ?? 'bentwood_cafe', wood = woodM(p.woodTone), seat = mat(p.seatColor || '#7a4a2a', { roughness: 0.8 }), met = metalM(p.metalFinish);
    const sy = 1.5, r = Math.min(w, d) / 2 * 0.92;
    const legs = (m, splay = 0, rr = 0.035) => { for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(rod([x * (w / 2 - 0.12) * (1 + splay), 0, z * (d / 2 - 0.12) * (1 + splay)], [x * (w / 2 - 0.15), sy, z * (d / 2 - 0.15)], rr, m)); };
    if (style === 'bentwood_cafe' || style === 'metal_bistro') {
      const fm = style === 'metal_bistro' ? met : wood;
      g.add(cyl(r, r, 0.08, style === 'metal_bistro' ? met : mat('#ffffff', { map: weaveTex('#d6b98a'), roughness: 1 }), 0, sy, 0, 24));
      const rim = mesh(new THREE.TorusGeometry(r * 1.0, 0.03, 6, 24), fm, 0, sy + 0.04, 0); rim.rotation.x = Math.PI / 2; g.add(rim);
      for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + (i * Math.PI) / 2; g.add(rod([Math.cos(a) * r * 1.05, 0, Math.sin(a) * r * 1.05], [Math.cos(a) * r * 0.75, sy, Math.sin(a) * r * 0.75], 0.03, fm)); }
      const ring = mesh(new THREE.TorusGeometry(r * 0.78, 0.025, 6, 24), fm, 0, 0.55, 0); ring.rotation.x = Math.PI / 2; g.add(ring);
      const bh = Math.max(h - sy, 0.8), rb = r * 0.85;
      for (const [k, rad] of [[1, rb], [0.6, rb * 0.62]]) { const hoop = mesh(new THREE.TorusGeometry(rad, 0.03, 6, 20, Math.PI), fm, 0, sy + 0.05, -r * 0.85); hoop.scale.y = (bh * k) / rad; hoop.rotation.x = -0.12; g.add(hoop); }
    } else if (style === 'wishbone') {
      legs(wood, 0.05, 0.04);
      g.add(box(w - 0.1, 0.1, d - 0.18, mat('#ffffff', { map: weaveTex(p.seatColor || '#c9a26e'), roughness: 1 }), 0, sy, 0.03));
      const crestY = sy + Math.max(h - sy, 0.9) * 0.75;
      const crest = mesh(new THREE.TorusGeometry(w / 2 * 0.85, 0.05, 6, 18, Math.PI), wood, 0, crestY, -d / 2 + w / 2 * 0.85); crest.rotation.x = Math.PI / 2; crest.rotation.z = Math.PI; g.add(crest);
      g.add(rod([0, sy + 0.1, -d / 2 + 0.2], [0, crestY - 0.25, -d / 2 + 0.1], 0.03, wood)); g.add(rod([0, crestY - 0.25, -d / 2 + 0.1], [-0.25, crestY, -d / 2 + 0.1], 0.03, wood)); g.add(rod([0, crestY - 0.25, -d / 2 + 0.1], [0.25, crestY, -d / 2 + 0.1], 0.03, wood));
      for (const s of [-1, 1]) g.add(rod([s * (w / 2 - 0.12), 0, -d / 2 + 0.12], [s * w / 2 * 0.85, crestY, -d / 2 + 0.15], 0.04, wood));
    } else if (style === 'upholstered') {
      legs(wood, 0, 0.04);
      g.add(box(w - 0.05, 0.3, d - 0.1, seat, 0, sy - 0.1, 0.02));
      const piv = new THREE.Group(); piv.position.set(0, sy + 0.15, -d / 2 + 0.12); piv.rotation.x = -0.1; piv.add(box(w - 0.08, Math.max(h - sy - 0.15, 0.8), 0.2, seat, 0, 0, 0)); g.add(piv);
    } else { // windsor
      legs(wood, 0.12, 0.04);
      g.add(box(w, 0.13, d - 0.1, wood, 0, sy - 0.05, 0.02));
      const crestY = sy + Math.max(h - sy, 0.9);
      const crest = mesh(new THREE.TorusGeometry(w / 2 * 0.9, 0.05, 6, 18, Math.PI), wood, 0, crestY, -d / 2 + 0.5); crest.rotation.x = Math.PI / 2; crest.rotation.z = Math.PI; crest.scale.y = 0.6; g.add(crest);
      for (let i = 0; i < 7; i++) { const a = Math.PI * (i + 0.5) / 7; g.add(rod([Math.cos(a) * w / 2 * 0.8, sy + 0.08, -d / 2 + 0.5 - Math.sin(a) * 0.3], [Math.cos(a) * w / 2 * 0.9, crestY, -d / 2 + 0.5 - Math.sin(a) * w / 2 * 0.9 * 0.6], 0.022, wood, 5)); }
    }
  },
  pouf(g, w, d, h, p) {
    const c = p.color || '#c9b79c', matl = p.material ?? 'knit';
    const m = matl === 'leather' ? mat(c, { roughness: 0.45 }) : matl === 'velvet' ? mat(c, { roughness: 0.55 })
      : matl === 'jute' ? mat('#ffffff', { map: weaveTex(c), roughness: 1 }) : mat(c, { roughness: 1, map: matl === 'knit' ? weaveTex('#ffffff') : noiseTex('#ffffff', 'b') });
    if ((p.shape ?? 'round') === 'round') {
      const r = Math.min(w, d) / 2;
      g.add(cyl(r * 0.96, r * 0.9, h * 0.82, m, 0, 0, 0, 24));
      const cap = mesh(new THREE.SphereGeometry(r * 0.96, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2), m, 0, h * 0.82, 0); cap.scale.y = (h * 0.18) / (r * 0.96); g.add(cap);
    } else {
      g.add(box(w, h * 0.92, d, m)); g.add(box(w - 0.08, h * 0.08, d - 0.08, m, 0, h * 0.92, 0));
      if (p.shape === 'rect') for (const s of [-1, 1]) g.add(box(w - 0.1, 0.03, 0.02, mat(shade(c, -0.25)), 0, h * 0.5, s * d / 2));
    }
  },
  drum_side_table(g, w, d, h, p) {
    const c = p.color || '#3b2f27', ml = p.material ?? 'wood', r = Math.min(w, d) / 2;
    const m = mat(c, { roughness: ml === 'ceramic' ? 0.3 : ml === 'plaster' ? 1 : ml === 'metal' ? 0.35 : 0.6, metalness: ml === 'metal' ? 0.8 : 0, map: ml === 'plaster' ? noiseTex('#ffffff', 'p') : null });
    const style = p.style ?? 'drum';
    if (style === 'waisted') {
      const pts = [[0, 0], [1, 0], [0.95, 0.12], [0.55, 0.5], [0.95, 0.88], [1, 1], [0, 1]].map(([x, y]) => new THREE.Vector2(x * r, y * h));
      g.add(mesh(new THREE.LatheGeometry(pts, 28), m));
    } else if (style === 'fluted' || style === 'stump') {
      const geo = new THREE.CylinderGeometry(r, r, h, style === 'fluted' ? 72 : 14, style === 'stump' ? 4 : 1), pos = geo.attributes.position, rr = rng(4);
      for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i), rad = Math.hypot(x, z); if (rad < r * 0.5) continue; const a = Math.atan2(z, x); const k = style === 'fluted' ? 1 - 0.07 * (0.5 + 0.5 * Math.cos(a * 18)) : 0.9 + 0.12 * rr(); pos.setX(i, Math.cos(a) * r * k); pos.setZ(i, Math.sin(a) * r * k); }
      geo.computeVertexNormals();
      const top = style === 'stump' ? mat('#c9a978', { roughness: 0.8, map: canvasTex('stumptop', 128, 128, (gg, W) => { gg.fillStyle = '#d2b48a'; gg.fillRect(0, 0, W, W); gg.strokeStyle = 'rgba(90,60,30,0.45)'; for (let i = 4; i < W / 2; i += 6) { gg.lineWidth = 1 + (i % 3); gg.beginPath(); gg.arc(W / 2, W / 2, i, 0, 7); gg.stroke(); } }) }) : m;
      const o = mesh(geo, style === 'stump' ? [mat(c, { roughness: 1, flatShading: true }), top, top] : m, 0, h / 2, 0); g.add(o);
    } else { g.add(cyl(r, r, h, m, 0, 0, 0, 32)); g.add(cyl(r * 1.01, r * 1.01, 0.03, mat(shade(c, -0.25)), 0, h - 0.06, 0, 32)); }
  },
  console_table(g, w, d, h, p) {
    const wood = woodM(p.woodTone), legStyle = p.legStyle ?? 'tapered', t = 0.1;
    const top = p.top === 'stone' ? mat('#ffffff', { map: marbleTex(), roughness: 0.35 }) : p.top === 'glass' ? new THREE.MeshStandardMaterial({ color: '#cfe3e6', transparent: true, opacity: 0.45, roughness: 0.05 }) : wood;
    g.add(box(w, t, d, top, 0, h - t, 0));
    const lm = legStyle === 'metal' ? metalM(p.metalFinish) : wood;
    if (legStyle === 'plinth') { for (const s of [-1, 1]) g.add(box(0.18, h - t, d - 0.05, wood, s * (w / 2 - 0.12), 0, 0)); }
    else for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(legStyle === 'block' ? box(0.15, h - t, 0.15, lm, sx * (w / 2 - 0.12), 0, sz * (d / 2 - 0.1)) : legStyle === 'metal' ? cyl(0.025, 0.025, h - t, lm, sx * (w / 2 - 0.1), 0, sz * (d / 2 - 0.08), 8) : cyl(0.045, 0.028, h - t, lm, sx * (w / 2 - 0.12), 0, sz * (d / 2 - 0.1), 8));
    g.add(box(w - 0.1, 0.12, 0.05, wood, 0, h - t - 0.12, d / 2 - 0.08));
    if (truthy(p.shelf ?? true)) g.add(box(w - 0.3, 0.06, d - 0.15, wood, 0, 0.5, 0));
  },
  cafe_table(g, w, d, h, p) {
    const wood = woodM(p.woodTone), t = 0.1, shape = p.shape ?? 'round', base = p.base ?? 'pedestal', met = metalM(p.metalFinish);
    const topM = p.top === 'marble' ? mat('#ffffff', { map: marbleTex(), roughness: 0.3 }) : p.top === 'glass' ? new THREE.MeshStandardMaterial({ color: '#cfe3e6', transparent: true, opacity: 0.45, roughness: 0.05 }) : wood;
    if (shape === 'round' || shape === 'oval') { const o = mesh(new THREE.CylinderGeometry(0.5, 0.5, t, 40), topM, 0, h - t / 2, 0); o.scale.set(w, 1, shape === 'round' ? Math.min(w, d) : d); if (shape === 'round') o.scale.x = Math.min(w, d); g.add(o); }
    else g.add(box(w, t, d, topM, 0, h - t, 0));
    const H = h - t;
    if (base === 'pedestal') { g.add(cyl(0.08, 0.1, H, met, 0, 0, 0, 12)); for (let i = 0; i < 4; i++) { const a = box(Math.min(w, d) * 0.38, 0.05, 0.1, met, 0, 0, 0); a.geometry.translate(Math.min(w, d) * 0.19, 0, 0); a.rotation.y = Math.PI / 4 + (i * Math.PI) / 2; g.add(a); } }
    else if (base === 'tulip') { const pts = [[0.9, 0], [0.75, 0.03], [0.3, 0.2], [0.18, 0.55], [0.22, 0.9], [0.45, 1]].map(([x, y]) => new THREE.Vector2(x * Math.min(w, d) / 2 * 0.7, y * H)); g.add(mesh(new THREE.LatheGeometry(pts, 28), p.top === 'marble' ? mat('#efece6', { roughness: 0.4 }) : wood)); }
    else if (base === 'trestle') { for (const s of [-1, 1]) { g.add(box(0.15, H, d * 0.6, wood, s * (w / 2 - 0.4), 0, 0)); g.add(box(0.2, 0.12, d * 0.8, wood, s * (w / 2 - 0.4), 0, 0)); } g.add(box(w - 0.8, 0.12, 0.12, wood, 0, H * 0.35, 0)); }
    else for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(cyl(0.05, 0.035, H, wood, sx * (w / 2 - 0.25) * (shape === 'round' ? 0.75 : 1), 0, sz * (d / 2 - 0.25) * (shape === 'round' ? 0.75 : 1), 8));
  },
  display_cabinet(g, w, d, h, p, ctx) {
    const wood = woodM(p.woodTone), legH = p.legStyle === 'plinth' ? 0.3 : ft(num(p.legHeightIn, 4)), arched = (p.top ?? 'arched') === 'arched';
    const lit = truthy(p.lit), k = KELVIN[2700], t = 0.07;
    if (legH > 0.01) { if (p.legStyle === 'plinth') g.add(box(w - 0.1, legH, d - 0.1, wood)); else for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(p.legStyle === 'metal' ? cyl(0.025, 0.025, legH, metalM(p.metalFinish), sx * (w / 2 - 0.1), 0, sz * (d / 2 - 0.1), 8) : cyl(0.05, 0.03, legH, wood, sx * (w / 2 - 0.12), 0, sz * (d / 2 - 0.1), 8)); }
    const archH = arched ? Math.min(w / 2, h * 0.25) : 0, bodyH = h - legH - archH, y0 = legH;
    g.add(box(w, t, d, wood, 0, y0, 0)); g.add(box(w, bodyH, t, wood, 0, y0, -d / 2 + t / 2));
    for (const s of [-1, 1]) g.add(box(t, bodyH, d, wood, s * (w / 2 - t / 2), y0, 0));
    if (arched) { const cap = mesh(new THREE.CylinderGeometry(w / 2, w / 2, d, 24, 1, false, Math.PI / 2, Math.PI), wood, 0, y0 + bodyH, 0); cap.rotation.x = Math.PI / 2; cap.scale.z = archH / (w / 2); g.add(cap); }
    else g.add(box(w, t, d, wood, 0, y0 + bodyH - t, 0));
    const n = clamp(Math.round(num(p.shelfCount, 4)), 0, 8), sh = (bodyH - t) / (n + 1), deco = [mat('#e8e2d6', { roughness: 0.4 }), mat('#2b2a28'), mat('#a8622f'), mat('#6f7f6a')];
    for (let i = 0; i <= n; i++) {
      const y = y0 + t + i * sh;
      if (i) g.add(box(w - 2 * t, 0.04, d - t - 0.05, p.doors === 'glass' || p.doors === 'fluted_glass' ? new THREE.MeshStandardMaterial({ color: '#dfeeee', transparent: true, opacity: 0.4 }) : wood, 0, y, 0));
      g.add(cyl(0.1, 0.08, sh * 0.5, deco[i % 4], -w * 0.22, y + 0.04, 0, 12)); g.add(box(w * 0.22, sh * 0.6, d * 0.45, deco[(i + 1) % 4], w * 0.15, y + 0.04, -0.05));
    }
    const door = p.doors ?? 'fluted_glass';
    if (door !== 'open') {
      const dm = door === 'wood' ? wood : new THREE.MeshStandardMaterial({ color: '#e7f0ef', transparent: true, opacity: door === 'fluted_glass' ? 0.7 : 0.3, roughness: 0.15, map: door === 'fluted_glass' ? flutedTex() : null, depthWrite: false });
      const dw = (w - 2 * t) / 2;
      for (const s of [-1, 1]) {
        const x = s * dw / 2;
        g.add(box(dw - 0.02, bodyH - t, 0.02, dm, x, y0 + t, d / 2 - 0.01));
        for (const fx of [-1, 1]) g.add(box(0.05, bodyH - t, 0.03, wood, x + fx * (dw / 2 - 0.025), y0 + t, d / 2));
        g.add(box(dw, 0.05, 0.03, wood, x, y0 + t, d / 2)); g.add(box(dw, 0.05, 0.03, wood, x, y0 + bodyH - 0.05, d / 2));
        g.add(box(0.03, 0.25, 0.04, metalM(p.metalFinish), -s * 0.05, y0 + bodyH * 0.5, d / 2 + 0.03));
      }
    }
    if (lit) { g.add(box(w - 0.3, 0.02, 0.05, new THREE.MeshBasicMaterial({ color: k }), 0, y0 + bodyH - t - 0.04, -d / 2 + 0.15)); ctx.light(0, y0 + bodyH - 0.4, d / 2 + 0.2, k, 1); }
  },
  tv(g, w, d, h, p) {
    const screenIn = num(p.screenIn, 65), W = ft(screenIn * 0.872), H = ft(screenIn * 0.49), stand = p.mount === 'stand';
    const cy = stand ? H / 2 + 0.25 : Math.max(ft(num(p.centerHeightIn, 52)), H / 2), z = stand ? 0 : -d / 2 + 0.06;
    g.add(box(W, H, 0.1, mat('#111111', { roughness: 0.3 }), 0, cy - H / 2, z));
    const art = truthy(p.artMode);
    const scr = mesh(new THREE.PlaneGeometry(W - 0.06, H - 0.06), art ? mat('#ffffff', { map: artTex('landscape', '#7b8a6a', 3), roughness: 0.9 }) : new THREE.MeshStandardMaterial({ color: '#151b23', roughness: 0.15, metalness: 0.3 }), 0, cy, z + 0.052);
    g.add(scr);
    if (art) g.add(box(W + 0.06, H + 0.06, 0.08, mat('#e9e4da'), 0, cy - H / 2 - 0.03, z - 0.005));
    if (stand) { g.add(box(0.5, 0.04, 0.6, mat('#1d1d1d'), 0, 0, 0)); g.add(box(0.12, 0.3, 0.06, mat('#1d1d1d'), 0, 0, 0)); }
  },
  electric_fireplace(g, w, d, h, p, ctx) {
    const style = p.style ?? 'insert', y0 = style === 'mantel' ? 0 : ft(num(p.bottomIn, 18)), flame = truthy(p.flame), sc = mat(p.surroundColor || '#2b2a28', { roughness: 0.8 });
    const fire = (fw, fh, fy, fz) => {
      g.add(box(fw, fh, 0.12, mat('#0b0a0a', { roughness: 1 }), 0, fy, fz));
      if (!flame) return;
      const f = mesh(new THREE.PlaneGeometry(fw * 0.9, fh * 0.6), new THREE.MeshBasicMaterial({ map: flameTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 0, fy + fh * 0.32, fz + 0.065); g.add(f);
      g.add(box(fw * 0.85, 0.05, 0.04, new THREE.MeshBasicMaterial({ color: '#ff7a2a' }), 0, fy + 0.03, fz + 0.06));
      ctx.light(0, fy + fh * 0.4, fz + 0.8, '#ff9a4a', 2);
    };
    if (style === 'mantel') {
      const wood = woodM(p.woodTone), fw = w * 0.62, fh = Math.min(h, 2), top = fh + 0.9;
      for (const s of [-1, 1]) g.add(box((w - fw) / 2, top, d, wood, s * (w / 2 - (w - fw) / 4), 0, 0));
      g.add(box(fw, top - fh - 0.25, d, wood, 0, fh + 0.25, 0)); g.add(box(w + 0.2, 0.12, d + 0.15, wood, 0, top, 0.05));
      g.add(box(fw, 0.25, d, sc, 0, 0, 0));
      fire(fw, fh, 0.25, d / 2 - 0.06);
    } else if (style === 'linear') {
      g.add(box(w, h * 0.7, d * 0.4, sc, 0, y0, -d / 2 + d * 0.2)); fire(w - 0.15, h * 0.7 - 0.15, y0 + 0.075, -d / 2 + d * 0.4 + 0.01);
    } else {
      g.add(box(w, h, d * 0.5, sc, 0, y0, -d / 2 + d * 0.25)); fire(w * 0.86, h * 0.78, y0 + h * 0.11, -d / 2 + d * 0.5 + 0.01);
      g.add(box(w * 0.4, 0.12, 0.08, mat('#4a3a2c'), 0, y0 + h * 0.13, -d / 2 + d * 0.5 + 0.08));
    }
  },
};
/** Ceiling fixtures from a scan or Current (fixtures table): fans and lights, drawn but not editable here. */
export function buildFixture(g, f, ctx) {
  if (f.type === 'ceiling_fan') DECOR.ceiling_fan(g, 4.3, 4.3, 1.1, { bladeCount: '5', bladeFinish: 'walnut', metalFinish: 'black', lightKit: 'true', lit: 'true', dropIn: '6' }, ctx);
  else { const top = ceilingTop(ctx); g.add(cyl(0.45, 0.55, 0.2, shadeMat('glass', KELVIN[2700], true), 0, top - 0.2, 0, 20)); ctx.light(0, top - 0.4, 0, KELVIN[2700], 1); }
}
