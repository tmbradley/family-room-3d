// Furniture catalog. Dimensions are in INCHES (w = width, d = depth, h = height).
// `kind` picks the 3D builder in main.js: sofa | chair | coffeeTable | rug | console | lamp | box.
// `url` and `price` are optional, so this array can later be swapped for rows from a Notion database.
export const CATALOG = [
  { id: 'sofa',    kind: 'sofa',        name: 'Sofa',              w: 84, d: 36, h: 32, color: '#c9b79c', legColor: '#5a3a22', url: '', price: null },
  { id: 'chair',   kind: 'chair',       name: 'Lounge chair',      w: 32, d: 34, h: 30, color: '#9a5a2e', legColor: '#5a3a22', url: '', price: null },
  { id: 'coffee',  kind: 'coffeeTable', name: 'Coffee table',      w: 48, d: 24, h: 16, color: '#6b4429', url: '', price: null },
  { id: 'rug',     kind: 'rug',         name: 'Area rug 8x10',     w: 96, d: 120, h: 0.5, color: '#efe6d6', accent: '#a8622f', url: '', price: null },
  { id: 'console', kind: 'console',     name: 'Media console + TV', w: 70, d: 18, h: 24, color: '#6b4429', tv: { w: 57, h: 33 }, url: '', price: null },
  { id: 'lamp',    kind: 'lamp',        name: 'Floor lamp',        w: 12, d: 12, h: 60, color: '#b8913f', url: '', price: null },
];

// Default layout, in room feet. x: 0 = fireplace wall -> 12 = open side. z: 0 = front wall -> 13 = back (window) wall.
// rot is degrees about the vertical axis; 0 = item faces the front wall, 180 = faces the back wall,
// 270 = faces the fireplace (left), 90 = faces the open side.
export const DEFAULT_LAYOUT = [
  { type: 'rug',     x: 5.5,  z: 6.5,  rot: 0 },
  { type: 'sofa',    x: 10.0, z: 6.5,  rot: 270 },
  { type: 'coffee',  x: 6.25, z: 6.5,  rot: 90 },
  { type: 'chair',   x: 5.5,  z: 11.25, rot: 0 },
  { type: 'console', x: 5.0,  z: 0.85, rot: 180 },
  { type: 'lamp',    x: 11.0, z: 10.75, rot: 0 },
];
