/**
 * Parametric furniture library. The definitions live here (code), and syncTemplates() mirrors them
 * into furniture_templates / template_params / template_param_options / template_categories at
 * startup, so the database stays relational and foreign keys work. Placements pick a template
 * (placements.template_id) and store their values in placement_params, which go through the
 * change engine like any other field (revisions, proposals, rollback).
 */
import type { Tx } from './entities.js';
import { ApiError } from './util.js';

type Param =
  | { key: string; label: string; type: 'number'; default: number; min: number; max: number }
  | { key: string; label: string; type: 'choice'; default: string; options: [string, string][] }
  | { key: string; label: string; type: 'color'; default: string }
  | { key: string; label: string; type: 'boolean'; default: boolean };

/** Sections of the Add furniture menu (template_groups). */
export const GROUPS = [
  { key: 'furniture', label: 'Furniture' },
  { key: 'lighting', label: 'Lighting' },
  { key: 'wall_decor', label: 'Wall decor' },
  { key: 'soft_goods', label: 'Soft goods and plants' },
] as const;
export type GroupKey = (typeof GROUPS)[number]['key'];
/**
 * floor: stands on the floor. wall: hung on a wall at a height (the editor snaps it to the nearest wall,
 * facing into the room). ceiling: hangs from the ceiling. surface: sits on top of the furniture under it
 * (or the floor). soft: lies on the seat of the sofa or chair under it.
 */
export type Mount = 'floor' | 'wall' | 'ceiling' | 'surface' | 'soft';

export type TemplateDef = {
  slug: string; name: string; kind: string; w: number; d: number; h: number; categories: string[]; params: Param[];
  group?: GroupKey; mount?: Mount; price?: [number, number]; description?: string;
};

const legStyle: Param = { key: 'legStyle', label: 'Legs', type: 'choice', default: 'tapered', options: [['tapered', 'Tapered wood'], ['block', 'Block'], ['metal', 'Metal'], ['plinth', 'Plinth (no legs)']] };
const legHeight: Param = { key: 'legHeightIn', label: 'Leg height (in)', type: 'number', default: 4, min: 0, max: 30 };
const fabric: Param = { key: 'fabricColor', label: 'Fabric', type: 'color', default: '#5b5f66' };
const wood: Param = { key: 'woodTone', label: 'Wood tone', type: 'choice', default: 'walnut', options: [['walnut', 'Walnut'], ['oak', 'Oak'], ['white_oak', 'White oak'], ['ebony', 'Ebony'], ['painted_white', 'Painted white']] };
const metal: Param = { key: 'metalFinish', label: 'Metal finish', type: 'choice', default: 'brass', options: [['brass', 'Brass'], ['black', 'Black'], ['chrome', 'Chrome'], ['bronze', 'Bronze']] };
const arms: Param = { key: 'armStyle', label: 'Arms', type: 'choice', default: 'track', options: [['track', 'Track'], ['rolled', 'Rolled'], ['slope', 'Sloped'], ['none', 'Armless']] };
const seatDepth: Param = { key: 'seatDepthIn', label: 'Seat depth (in)', type: 'number', default: 22, min: 16, max: 36 };
const cushions = (d: number): Param => ({ key: 'cushionCount', label: 'Seat cushions', type: 'number', default: d, min: 1, max: 6 });
// Lights and wall pieces
const lit: Param = { key: 'lit', label: 'Light on', type: 'boolean', default: true };
const bulb: Param = { key: 'bulbK', label: 'Bulb', type: 'choice', default: '2700', options: [['2200', '2200K candle warm'], ['2700', '2700K warm'], ['3000', '3000K soft white']] };
const height = (key: string, label: string, def: number, max = 130): Param => ({ key, label, type: 'number', default: def, min: 0, max });
const shadeShape: Param = { key: 'shape', label: 'Shade shape', type: 'choice', default: 'globe', options: [['globe', 'Globe'], ['drum', 'Drum'], ['cone', 'Cone'], ['ufo_paper', 'UFO paper lantern']] };
const shadeMaterial: Param = { key: 'material', label: 'Shade material', type: 'choice', default: 'rattan', options: [['rattan', 'Rattan / woven'], ['paper', 'Paper'], ['brass', 'Brass'], ['glass', 'Glass']] };
const pieceColor = (def: string, label = 'Color', key = 'color'): Param => ({ key, label, type: 'color', default: def });

export const TEMPLATES: TemplateDef[] = [
  // ---------- Furniture ----------
  { slug: 'l_sectional', name: 'L-sectional', kind: 'sectional', w: 112, d: 86, h: 32, categories: ['sofa'], price: [1200, 4000],
    params: [arms, { key: 'chaiseSide', label: 'Chaise side', type: 'choice', default: 'right', options: [['left', 'Left'], ['right', 'Right']] },
      { key: 'chaiseDepthIn', label: 'Chaise length (in)', type: 'number', default: 66, min: 40, max: 120 },
      { key: 'chaiseWidthIn', label: 'Chaise width (in, 0 = seat depth)', type: 'number', default: 0, min: 0, max: 80 },
      { key: 'ottomanSide', label: 'Attached ottoman', type: 'choice', default: 'none', options: [['none', 'None'], ['left', 'Left end'], ['right', 'Right end']] },
      { key: 'ottomanWidthIn', label: 'Ottoman width (in)', type: 'number', default: 36, min: 12, max: 80 },
      { key: 'ottomanDepthIn', label: 'Ottoman depth (in)', type: 'number', default: 30, min: 12, max: 60 },
      seatDepth, cushions(3), fabric, legStyle, legHeight] },
  { slug: 'sofa', name: 'Sofa', kind: 'sofa', w: 84, d: 36, h: 32, categories: ['sofa'], price: [800, 3000], params: [arms, seatDepth, cushions(3), fabric, legStyle, legHeight, wood] },
  { slug: 'armchair', name: 'Armchair', kind: 'chair', w: 32, d: 34, h: 32, categories: ['chair', 'sofa'], price: [300, 1500], params: [arms, fabric, legStyle, legHeight, wood] },
  { slug: 'swivel_chair', name: 'Swivel chair', kind: 'chair', w: 32, d: 34, h: 30, categories: ['chair'], price: [300, 1500],
    params: [fabric, { key: 'baseStyle', label: 'Base', type: 'choice', default: 'disc', options: [['disc', 'Round disc'], ['star', 'Star base']] }, metal] },
  { slug: 'wood_frame_lounge_chair', name: 'Lounge chair, wood frame', kind: 'chair', w: 28, d: 32, h: 30, categories: [], price: [200, 1200],
    description: 'Mid-century lounge chair: exposed wood frame with loose seat and back cushions.',
    params: [wood, fabric, { key: 'arms', label: 'Sides', type: 'choice', default: 'open_wood', options: [['open_wood', 'Open wood arms'], ['slat', 'Slatted sides'], ['none', 'Armless']] },
      { key: 'backHeight', label: 'Back', type: 'choice', default: 'low', options: [['low', 'Low back'], ['high', 'High back']] }] },
  { slug: 'dining_chair', name: 'Dining or café chair', kind: 'chair', w: 19, d: 21, h: 32, categories: [], price: [60, 300],
    params: [{ key: 'style', label: 'Style', type: 'choice', default: 'bentwood_cafe', options: [['bentwood_cafe', 'Bentwood café'], ['wishbone', 'Wishbone'], ['upholstered', 'Upholstered'], ['metal_bistro', 'Metal bistro'], ['windsor', 'Windsor spindle']] },
      wood, pieceColor('#7a4a2a', 'Seat', 'seatColor'), metal] },
  { slug: 'pouf', name: 'Pouf or ottoman', kind: 'ottoman', w: 20, d: 20, h: 16, categories: [], price: [50, 300],
    params: [{ key: 'shape', label: 'Shape', type: 'choice', default: 'round', options: [['round', 'Round'], ['square', 'Square'], ['rect', 'Rectangular bench']] },
      { key: 'material', label: 'Material', type: 'choice', default: 'knit', options: [['knit', 'Chunky knit'], ['leather', 'Leather'], ['jute', 'Jute'], ['boucle', 'Bouclé'], ['velvet', 'Velvet']] }, pieceColor('#c9b79c')] },
  { slug: 'coffee_table', name: 'Coffee table', kind: 'table', w: 48, d: 24, h: 16, categories: ['table'], price: [150, 1000],
    params: [{ key: 'shape', label: 'Top', type: 'choice', default: 'rect', options: [['rect', 'Rectangle'], ['round', 'Round'], ['oval', 'Oval']] }, wood, legStyle, metal] },
  { slug: 'side_table', name: 'Side table', kind: 'table', w: 20, d: 20, h: 24, categories: ['table'], price: [60, 400],
    params: [{ key: 'shape', label: 'Top', type: 'choice', default: 'round', options: [['rect', 'Square'], ['round', 'Round']] }, wood, metal] },
  { slug: 'drum_side_table', name: 'Drum or stump side table', kind: 'table', w: 18, d: 18, h: 20, categories: [], price: [60, 400],
    params: [{ key: 'style', label: 'Style', type: 'choice', default: 'drum', options: [['drum', 'Drum'], ['stump', 'Tree stump'], ['fluted', 'Fluted drum'], ['waisted', 'Waisted (hourglass)']] },
      { key: 'material', label: 'Material', type: 'choice', default: 'wood', options: [['wood', 'Wood'], ['ceramic', 'Ceramic'], ['plaster', 'Plaster'], ['metal', 'Metal']] }, pieceColor('#3b2f27', 'Finish')] },
  { slug: 'console_table', name: 'Console table', kind: 'table', w: 48, d: 14, h: 30, categories: [], price: [120, 600],
    params: [wood, legStyle, metal, { key: 'top', label: 'Top', type: 'choice', default: 'wood', options: [['wood', 'Wood'], ['stone', 'Stone'], ['glass', 'Glass']] },
      { key: 'shelf', label: 'Lower shelf', type: 'boolean', default: true }] },
  { slug: 'cafe_table', name: 'Café or dining table', kind: 'table', w: 30, d: 30, h: 29, categories: [], price: [120, 900],
    description: 'Table at dining height (29in): a 30in round café table by default; make it 72x36 for dining.',
    params: [{ key: 'shape', label: 'Top', type: 'choice', default: 'round', options: [['round', 'Round'], ['square', 'Square'], ['rect', 'Rectangle'], ['oval', 'Oval']] },
      { key: 'base', label: 'Base', type: 'choice', default: 'pedestal', options: [['pedestal', 'Pedestal'], ['four_legs', 'Four legs'], ['trestle', 'Trestle'], ['tulip', 'Tulip']] },
      wood, { key: 'top', label: 'Top material', type: 'choice', default: 'wood', options: [['wood', 'Wood'], ['marble', 'Marble'], ['glass', 'Glass']] }, metal] },
  { slug: 'media_console', name: 'Media console', kind: 'media', w: 70, d: 18, h: 24, categories: ['storage'], price: [200, 1500],
    params: [{ key: 'doorCount', label: 'Doors', type: 'number', default: 3, min: 0, max: 6 }, wood, legStyle, legHeight, metal] },
  { slug: 'display_cabinet', name: 'Display cabinet, glass or fluted', kind: 'storage', w: 32, d: 15, h: 71, categories: [], price: [200, 1200],
    params: [{ key: 'doors', label: 'Doors', type: 'choice', default: 'fluted_glass', options: [['glass', 'Clear glass'], ['fluted_glass', 'Fluted glass'], ['wood', 'Wood'], ['open', 'Open']] },
      { key: 'top', label: 'Top', type: 'choice', default: 'arched', options: [['flat', 'Flat'], ['arched', 'Arched']] },
      wood, { key: 'shelfCount', label: 'Shelves', type: 'number', default: 4, min: 1, max: 8 }, { key: 'lit', label: 'Lit inside', type: 'boolean', default: true }, metal, legStyle, legHeight] },
  { slug: 'tv', name: 'TV', kind: 'tv', w: 57, d: 3, h: 33, categories: [], price: [300, 2000], mount: 'wall',
    description: 'Screen size sets width and height (width = 0.87 x diagonal, height = 0.49 x diagonal). Mounted on the wall at a center height, or on a stand on the furniture under it.',
    params: [{ key: 'screenIn', label: 'Screen size (in, diagonal)', type: 'number', default: 65, min: 24, max: 100 },
      { key: 'mount', label: 'Mount', type: 'choice', default: 'wall', options: [['wall', 'On the wall'], ['stand', 'On a stand']] },
      height('centerHeightIn', 'Center height (in, wall mount)', 52, 110),
      { key: 'artMode', label: 'Art frame (Frame TV look)', type: 'boolean', default: false }] },
  { slug: 'electric_fireplace', name: 'Electric fireplace insert', kind: 'fireplace', w: 50, d: 12, h: 24, categories: [], price: [250, 1500], mount: 'wall',
    params: [{ key: 'style', label: 'Style', type: 'choice', default: 'insert', options: [['insert', 'Insert in a media wall'], ['linear', 'Linear wall-mount'], ['mantel', 'Freestanding mantel']] },
      height('bottomIn', 'Bottom height (in)', 18, 80), pieceColor('#2b2a28', 'Surround', 'surroundColor'), { key: 'flame', label: 'Flame on', type: 'boolean', default: true }, wood] },
  { slug: 'rug', name: 'Rug', kind: 'rug', w: 96, d: 120, h: 0, categories: [], price: [150, 1500],
    params: [{ key: 'rugColor', label: 'Color', type: 'color', default: '#9a9184' }, { key: 'pattern', label: 'Pattern', type: 'choice', default: 'solid', options: [['solid', 'Solid'], ['border', 'Border'], ['geometric', 'Geometric']] }] },
  { slug: 'bed', name: 'Bed', kind: 'bed', w: 64, d: 84, h: 44, categories: ['bed'], price: [400, 2500],
    params: [{ key: 'size', label: 'Size', type: 'choice', default: 'queen', options: [['twin', 'Twin'], ['full', 'Full'], ['queen', 'Queen'], ['king', 'King']] },
      { key: 'headboard', label: 'Headboard', type: 'choice', default: 'upholstered', options: [['upholstered', 'Upholstered'], ['wood', 'Wood'], ['none', 'None']] }, fabric, wood, legHeight] },
  { slug: 'dresser', name: 'Dresser', kind: 'storage', w: 60, d: 20, h: 34, categories: ['storage'], price: [300, 2000],
    params: [{ key: 'drawerCount', label: 'Drawers', type: 'number', default: 6, min: 2, max: 12 }, wood, metal, legStyle, legHeight] },
  { slug: 'nightstand', name: 'Nightstand', kind: 'storage', w: 22, d: 18, h: 25, categories: ['storage', 'table'], price: [100, 600],
    params: [{ key: 'drawerCount', label: 'Drawers', type: 'number', default: 2, min: 0, max: 4 }, wood, metal, legStyle, legHeight] },
  { slug: 'desk', name: 'Desk', kind: 'desk', w: 54, d: 26, h: 30, categories: ['table'], price: [150, 1200], params: [wood, legStyle, metal, { key: 'drawers', label: 'Drawer', type: 'boolean', default: true }] },
  { slug: 'bookshelf', name: 'Bookshelf', kind: 'storage', w: 36, d: 14, h: 72, categories: ['storage'], price: [100, 800],
    params: [{ key: 'shelfCount', label: 'Shelves', type: 'number', default: 5, min: 1, max: 10 }, wood, { key: 'backPanel', label: 'Back panel', type: 'boolean', default: true }] },

  // ---------- Lighting ----------
  { slug: 'pendant', name: 'Pendant light', kind: 'pendant', w: 16, d: 16, h: 12, categories: [], group: 'lighting', mount: 'ceiling', price: [40, 250],
    description: 'Hangs from the ceiling. Drop = ceiling to the bottom of the shade.',
    params: [shadeShape, shadeMaterial, { key: 'dropIn', label: 'Drop (in, ceiling to shade bottom)', type: 'number', default: 30, min: 6, max: 96 }, metal, lit, bulb] },
  { slug: 'swag_pendants', name: 'Plug-in swag pendant cluster', kind: 'pendant', w: 36, d: 24, h: 12, categories: [], group: 'lighting', mount: 'ceiling', price: [90, 400],
    description: 'A cluster of plug-in pendants on swag hooks, at staggered drops, with cords swagged to the wall.',
    params: [{ key: 'count', label: 'Pendants', type: 'number', default: 3, min: 1, max: 5 }, { ...shadeShape }, { ...shadeMaterial },
      { key: 'dropIn', label: 'Longest drop (in)', type: 'number', default: 40, min: 6, max: 96 }, { key: 'dropStepIn', label: 'Stagger (in)', type: 'number', default: 8, min: 0, max: 30 },
      { key: 'cord', label: 'Cord', type: 'choice', default: 'black', options: [['black', 'Black'], ['white', 'White'], ['natural', 'Natural jute']] }, lit, bulb] },
  { slug: 'wall_sconce', name: 'Wall sconce', kind: 'sconce', w: 6, d: 7, h: 10, categories: [], group: 'lighting', mount: 'wall', price: [35, 220],
    params: [{ key: 'style', label: 'Style', type: 'choice', default: 'dome', options: [['dome', 'Dome'], ['cylinder', 'Cylinder up/down'], ['globe', 'Globe'], ['plate', 'Plate uplight']] },
      metal, { key: 'shadeMaterial', label: 'Shade', type: 'choice', default: 'glass', options: [['glass', 'Glass'], ['paper', 'Paper'], ['rattan', 'Rattan'], ['metal', 'Metal']] },
      height('mountHeightIn', 'Center height (in)', 66), { key: 'plugIn', label: 'Plug-in (cord)', type: 'boolean', default: true }, lit, bulb] },
  { slug: 'swing_arm_lamp', name: 'Swing-arm wall lamp', kind: 'sconce', w: 8, d: 24, h: 10, categories: [], group: 'lighting', mount: 'wall', price: [45, 200],
    params: [{ key: 'armLengthIn', label: 'Arm reach (in)', type: 'number', default: 20, min: 8, max: 40 },
      { key: 'shadeShape', label: 'Shade', type: 'choice', default: 'cone', options: [['cone', 'Cone'], ['drum', 'Drum'], ['dome', 'Dome']] }, pieceColor('#2f4a3a', 'Shade color', 'shadeColor'), metal,
      height('mountHeightIn', 'Mount height (in)', 60), lit, bulb] },
  { slug: 'table_lamp', name: 'Table lamp', kind: 'lamp', w: 14, d: 14, h: 24, categories: [], group: 'lighting', mount: 'surface', price: [30, 250],
    description: 'Sits on the table, console or nightstand under it.',
    params: [{ key: 'base', label: 'Base', type: 'choice', default: 'ceramic', options: [['ceramic', 'Ceramic'], ['clay', 'Clay / terracotta'], ['brass', 'Brass'], ['glass', 'Glass'], ['wood', 'Wood']] },
      pieceColor('#c9b79c', 'Base color', 'baseColor'),
      { key: 'shade', label: 'Shade', type: 'choice', default: 'drum', options: [['drum', 'Drum'], ['pleated', 'Pleated'], ['cone', 'Cone'], ['mushroom', 'Mushroom']] },
      pieceColor('#efe7d8', 'Shade color', 'shadeColor'), lit, bulb] },
  { slug: 'floor_lamp', name: 'Floor lamp', kind: 'lamp', w: 14, d: 14, h: 62, categories: [], group: 'lighting', price: [60, 400],
    params: [metal, { key: 'shadeColor', label: 'Shade', type: 'color', default: '#efe7d8' }, { key: 'arc', label: 'Arc lamp', type: 'boolean', default: false },
      { key: 'shadeStyle', label: 'Shade style', type: 'choice', default: 'drum', options: [['drum', 'Drum'], ['pleated', 'Pleated'], ['cone', 'Cone'], ['globe', 'Globe']] }, lit, bulb] },
  { slug: 'led_strip', name: 'LED strip or cove light', kind: 'led', w: 72, d: 2, h: 1, categories: [], group: 'lighting', mount: 'wall', price: [20, 300],
    description: 'A line of warm light along a wall: a ceiling cove, under a shelf, behind the TV or console, or grazing a slat wall.',
    params: [{ key: 'placement', label: 'Where', type: 'choice', default: 'cove', options: [['cove', 'Ceiling cove'], ['shelf', 'Under a shelf'], ['behind_tv', 'Behind the TV / console'], ['grazing', 'Grazing a wall'], ['floor', 'Floor uplight']] },
      height('mountHeightIn', 'Height (in)', 96), bulb, lit] },
  { slug: 'ceiling_fan', name: 'Ceiling fan', kind: 'fan', w: 52, d: 52, h: 14, categories: [], group: 'lighting', mount: 'ceiling', price: [120, 600],
    description: 'Swap it for a pendant in a design: mark the fan "replace" and add a pendant that replaces it (the editor has a Swap for a pendant button).',
    params: [{ key: 'bladeCount', label: 'Blades', type: 'number', default: 5, min: 3, max: 8 },
      { key: 'bladeFinish', label: 'Blades', type: 'choice', default: 'walnut', options: [['walnut', 'Walnut'], ['oak', 'Oak'], ['black', 'Black'], ['white', 'White'], ['rattan', 'Rattan']] },
      { ...metal, default: 'black' }, { key: 'lightKit', label: 'Light kit', type: 'boolean', default: true }, { key: 'dropIn', label: 'Downrod (in)', type: 'number', default: 6, min: 0, max: 60 }, lit] },

  // ---------- Wall decor ----------
  { slug: 'framed_art', name: 'Framed art or print', kind: 'art', w: 24, d: 2, h: 36, categories: [], group: 'wall_decor', mount: 'wall', price: [30, 400],
    description: 'Width and height are the outer frame size. Height on the wall is to the center (57in is gallery height).',
    params: [pieceColor('#1d1d1d', 'Frame color', 'frameColor'),
      { key: 'frameStyle', label: 'Frame', type: 'choice', default: 'thin', options: [['thin', 'Thin frame'], ['mat', 'Frame with mat'], ['floating', 'Floating frame'], ['canvas', 'Canvas, no frame']] },
      { key: 'artStyle', label: 'Art', type: 'choice', default: 'abstract', options: [['abstract', 'Abstract'], ['landscape', 'Landscape'], ['botanical', 'Botanical'], ['line', 'Line drawing'], ['photo', 'Photo']] },
      pieceColor('#b5835a', 'Main art color', 'artColor'), height('mountHeightIn', 'Center height (in)', 57)] },
  { slug: 'gallery_wall', name: 'Gallery wall (grid)', kind: 'art', w: 60, d: 2, h: 40, categories: [], group: 'wall_decor', mount: 'wall', price: [120, 800],
    description: 'A grid of matching frames filling the width and height.',
    params: [{ key: 'rows', label: 'Rows', type: 'number', default: 2, min: 1, max: 5 }, { key: 'cols', label: 'Columns', type: 'number', default: 3, min: 1, max: 8 },
      { key: 'gapIn', label: 'Gap (in)', type: 'number', default: 3, min: 1, max: 12 }, pieceColor('#1d1d1d', 'Frame color', 'frameColor'),
      { key: 'mat', label: 'Mats', type: 'boolean', default: true }, pieceColor('#b5835a', 'Main art color', 'artColor'), height('mountHeightIn', 'Center height (in)', 57)] },
  { slug: 'wall_disk', name: 'Round sculptural disk', kind: 'art', w: 36, d: 3, h: 36, categories: [], group: 'wall_decor', mount: 'wall', price: [80, 600],
    params: [{ key: 'texture', label: 'Texture', type: 'choice', default: 'plaster', options: [['plaster', 'Textured plaster'], ['wood', 'Carved wood'], ['woven', 'Woven / rattan'], ['metal', 'Hammered metal']] },
      pieceColor('#2b2a28'), height('mountHeightIn', 'Center height (in)', 60)] },
  { slug: 'mirror', name: 'Arched or round mirror', kind: 'mirror', w: 24, d: 2, h: 36, categories: [], group: 'wall_decor', mount: 'wall', price: [60, 450],
    params: [{ key: 'shape', label: 'Shape', type: 'choice', default: 'arch', options: [['arch', 'Arch'], ['round', 'Round'], ['rect', 'Rectangle'], ['organic', 'Organic']] },
      { key: 'frame', label: 'Frame', type: 'choice', default: 'brass', options: [['brass', 'Brass'], ['black', 'Black'], ['wood', 'Wood'], ['none', 'Frameless']] },
      height('mountHeightIn', 'Center height (in)', 60), { key: 'lean', label: 'Leaning on the floor', type: 'boolean', default: false }] },
  { slug: 'wall_paneling', name: 'Wall paneling', kind: 'paneling', w: 96, d: 2, h: 96, categories: [], group: 'wall_decor', mount: 'wall', price: [150, 1200],
    description: 'Width and height are the paneled area; it starts at Bottom (in) above the floor.',
    params: [{ key: 'style', label: 'Style', type: 'choice', default: 'slats', options: [['slats', 'Vertical slats'], ['wainscot', 'Wainscot with ledge'], ['board_batten', 'Board and batten'], ['fluted', 'Fluted']] },
      { key: 'material', label: 'Material', type: 'choice', default: 'walnut', options: [['walnut', 'Walnut'], ['oak', 'Oak'], ['white_oak', 'White oak'], ['painted', 'Painted']] },
      pieceColor('#2f3a33', 'Paint color (painted)', 'paintColor'), { key: 'slatWidthIn', label: 'Slat width (in)', type: 'number', default: 2, min: 1, max: 8 },
      { key: 'gapIn', label: 'Gap (in)', type: 'number', default: 1, min: 0, max: 6 }, height('bottomIn', 'Bottom (in)', 0, 100),
      { key: 'ledge', label: 'Picture ledge on top', type: 'boolean', default: true }, { key: 'ledLit', label: 'LED grazing on top', type: 'boolean', default: false }] },
  { slug: 'lit_niche', name: 'Lit niche or built-in', kind: 'builtin', w: 36, d: 12, h: 60, categories: [], group: 'wall_decor', mount: 'wall', price: [150, 1500],
    params: [{ key: 'style', label: 'Style', type: 'choice', default: 'niche', options: [['niche', 'Recessed niche'], ['arched_niche', 'Arched niche'], ['shelves', 'Built-in shelves']] },
      { key: 'shelfCount', label: 'Shelves', type: 'number', default: 2, min: 0, max: 8 }, pieceColor('#3a2f28', 'Inside color', 'interiorColor'), pieceColor('#efece6', 'Surround color', 'frameColor'),
      height('bottomIn', 'Bottom (in)', 30, 100), { key: 'lit', label: 'Lit', type: 'boolean', default: true }, bulb] },

  // ---------- Soft goods and plants ----------
  { slug: 'curtains', name: 'Curtains or sheers', kind: 'curtain', w: 84, d: 4, h: 95, categories: [], group: 'soft_goods', mount: 'wall', price: [50, 500],
    description: 'Width = rod width. Hang it over a window: rod height from the floor, panel length, fullness (fabric width / rod width).',
    params: [height('rodHeightIn', 'Rod height (in)', 96, 160), { key: 'lengthIn', label: 'Panel length (in)', type: 'number', default: 95, min: 20, max: 160 },
      { key: 'fullness', label: 'Fullness', type: 'choice', default: '2', options: [['1.5', '1.5x'], ['2', '2x'], ['2.5', '2.5x'], ['3', '3x']] },
      pieceColor('#ebe3d3'), { key: 'opacity', label: 'Fabric', type: 'choice', default: 'sheer', options: [['sheer', 'Sheer'], ['light_filtering', 'Light filtering'], ['blackout', 'Blackout']] },
      { key: 'panels', label: 'Panels', type: 'choice', default: 'pair', options: [['pair', 'Pair'], ['single', 'Single']] },
      { key: 'openPercent', label: 'Open (%)', type: 'number', default: 60, min: 0, max: 100 }, { ...metal, default: 'black', key: 'rodFinish', label: 'Rod' }] },
  { slug: 'plant', name: 'Plant or tree in a planter', kind: 'plant', w: 24, d: 24, h: 60, categories: [], group: 'soft_goods', mount: 'surface', price: [30, 350],
    description: 'Height is the plant with its pot. On a shelf or table it sits on top.',
    params: [{ key: 'type', label: 'Plant', type: 'choice', default: 'fiddle_leaf', options: [['fiddle_leaf', 'Fiddle leaf fig'], ['bird_of_paradise', 'Bird of paradise'], ['olive_tree', 'Olive tree'], ['pothos', 'Pothos (trailing)'], ['snake_plant', 'Snake plant'], ['monstera', 'Monstera']] },
      { key: 'pot', label: 'Pot', type: 'choice', default: 'terracotta', options: [['terracotta', 'Terracotta'], ['white_ceramic', 'White ceramic'], ['black_ceramic', 'Black ceramic'], ['basket', 'Woven basket'], ['concrete', 'Concrete']] },
      { key: 'potHeightIn', label: 'Pot height (in)', type: 'number', default: 14, min: 3, max: 30 }] },
  { slug: 'pillows', name: 'Pillows (decor)', kind: 'decor', w: 60, d: 8, h: 18, categories: [], group: 'soft_goods', mount: 'soft', price: [40, 250],
    description: 'A row of throw pillows. Place it over a sofa or chair and it sits against the back of the seat.',
    params: [{ key: 'count', label: 'Pillows', type: 'number', default: 3, min: 1, max: 8 }, { key: 'sizeIn', label: 'Size (in)', type: 'number', default: 20, min: 12, max: 26 },
      pieceColor('#b5835a'), pieceColor('#2f3a33', 'Accent color', 'accentColor'), { key: 'alternate', label: 'Alternate colors', type: 'boolean', default: true },
      { key: 'texture', label: 'Fabric', type: 'choice', default: 'linen', options: [['linen', 'Linen'], ['velvet', 'Velvet'], ['boucle', 'Bouclé'], ['knit', 'Knit']] }] },
  { slug: 'throw_blanket', name: 'Throw (decor)', kind: 'decor', w: 50, d: 20, h: 2, categories: [], group: 'soft_goods', mount: 'soft', price: [30, 150],
    params: [pieceColor('#8a5a3c'), { key: 'style', label: 'Placed', type: 'choice', default: 'draped_arm', options: [['draped_arm', 'Draped over the arm'], ['folded_seat', 'Folded on the seat'], ['over_back', 'Over the back']] },
      { key: 'texture', label: 'Fabric', type: 'choice', default: 'knit', options: [['knit', 'Chunky knit'], ['linen', 'Linen'], ['faux_fur', 'Faux fur / sheepskin'], ['fringe', 'Woven with fringe']] }] },
];

export const templateBySlug = new Map(TEMPLATES.map((t) => [t.slug, t]));

/** Mirror TEMPLATES into the database (idempotent; keeps ids stable by slug). */
export async function syncTemplates(tx: Tx) {
  for (const [sort, g] of GROUPS.entries()) await tx.templateGroup.upsert({ where: { key: g.key }, create: { key: g.key, label: g.label, sort }, update: { label: g.label, sort } });
  for (const [sort, t] of TEMPLATES.entries()) {
    const meta = {
      name: t.name, kind: t.kind, defaultWIn: t.w, defaultDIn: t.d, defaultHIn: t.h, groupKey: t.group ?? 'furniture', mount: t.mount ?? 'floor',
      priceLowCents: t.price ? t.price[0] * 100 : null, priceHighCents: t.price ? t.price[1] * 100 : null, description: t.description ?? null, sort,
    };
    const row = await tx.furnitureTemplate.upsert({ where: { slug: t.slug }, create: { slug: t.slug, ...meta }, update: meta });
    await tx.templateCategory.deleteMany({ where: { templateId: row.id } });
    if (t.categories.length) await tx.templateCategory.createMany({ data: t.categories.map((category) => ({ templateId: row.id, category })) });
    await tx.templateParam.deleteMany({ where: { templateId: row.id, key: { notIn: t.params.map((p) => p.key) } } });
    for (const [sort, p] of t.params.entries()) {
      const data = {
        label: p.label, type: p.type, defaultValue: String(p.default), sort,
        minValue: p.type === 'number' ? p.min : null, maxValue: p.type === 'number' ? p.max : null,
      };
      const param = await tx.templateParam.upsert({ where: { templateId_key: { templateId: row.id, key: p.key } }, create: { templateId: row.id, key: p.key, ...data }, update: data });
      await tx.templateParamOption.deleteMany({ where: { paramId: param.id } });
      if (p.type === 'choice') await tx.templateParamOption.createMany({ data: p.options.map(([value, label], i) => ({ paramId: param.id, value, label, sort: i })) });
    }
  }
}

/** Templates as stored (what agents and the editor see). */
export async function listTemplates(tx: Tx) {
  const rows = await tx.furnitureTemplate.findMany({
    orderBy: [{ group: { sort: 'asc' } }, { sort: 'asc' }, { id: 'asc' }],
    include: { group: true, categories: true, params: { orderBy: { sort: 'asc' }, include: { options: { orderBy: { sort: 'asc' } } } } },
  });
  return rows.map((t) => ({
    id: t.id, slug: t.slug, name: t.name, kind: t.kind, defaults: { wIn: t.defaultWIn, dIn: t.defaultDIn, hIn: t.defaultHIn },
    group: t.groupKey, groupLabel: t.group.label, mount: t.mount, description: t.description,
    typicalPriceUsd: t.priceLowCents != null && t.priceHighCents != null ? { low: t.priceLowCents / 100, high: t.priceHighCents / 100 } : null,
    roomplanCategories: t.categories.map((c) => c.category),
    params: t.params.map((p) => ({
      key: p.key, label: p.label, type: p.type, default: p.defaultValue,
      ...(p.type === 'number' ? { min: p.minValue, max: p.maxValue } : {}),
      ...(p.type === 'choice' ? { options: p.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
    })),
  }));
}

/** Validate one parameter value for a template; returns the normalized string. */
export function checkParam(slug: string, key: string, value: unknown): string {
  const t = templateBySlug.get(slug);
  if (!t) throw new ApiError(400, 'unknown_template', `Unknown template ${slug}`);
  const p = t.params.find((x) => x.key === key);
  if (!p) throw new ApiError(400, 'unknown_param', `${t.name} has no parameter "${key}". Parameters: ${t.params.map((x) => x.key).join(', ')}`);
  const s = String(value);
  switch (p.type) {
    case 'number': { const n = Number(s); if (!Number.isFinite(n) || n < p.min || n > p.max) throw new ApiError(400, 'invalid_param', `${key} must be ${p.min}–${p.max}`); return String(Math.round(n)); }
    case 'choice': if (!p.options.some(([v]) => v === s)) throw new ApiError(400, 'invalid_param', `${key} must be one of ${p.options.map(([v]) => v).join(', ')}`); return s;
    case 'color': if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new ApiError(400, 'invalid_param', `${key} must be a color like #aabbcc`); return s.toLowerCase();
    case 'boolean': if (s !== 'true' && s !== 'false') throw new ApiError(400, 'invalid_param', `${key} must be true or false`); return s;
  }
}

/**
 * Closest template for a RoomPlan object: candidates by category, then the smallest relative size
 * difference (width, depth, height). An L-shaped sofa shows up in RoomPlan as one deep "sofa" box.
 */
export function matchTemplate(category: string, wIn: number, dIn: number, hIn: number) {
  let [w, d] = wIn >= dIn ? [wIn, dIn] : [dIn, wIn];
  const candidates = TEMPLATES.filter((t) => t.categories.includes(category));
  if (!candidates.length) return null;
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1);
  const scored = candidates.map((t) => {
    let score = rel(w, t.w) + rel(d, t.d) + 0.5 * rel(hIn, t.h);
    if (t.slug === 'l_sectional') score += w >= 90 && d >= 55 ? -0.5 : 1; // deep and wide = L
    if (t.slug === 'swivel_chair' && category === 'chair') score += 0.1;
    return { t, score };
  }).sort((a, b) => a.score - b.score);
  const best = scored[0].t;
  const params: Record<string, string> = {};
  if (best.slug === 'l_sectional') params.chaiseDepthIn = String(Math.max(40, Math.min(120, d)));
  if (best.slug === 'sofa' || best.slug === 'l_sectional') params.cushionCount = String(Math.max(1, Math.min(6, Math.round(w / 30))));
  return { slug: best.slug, name: best.name, score: Math.round(scored[0].score * 100) / 100, params, wIn: w, dIn: d, hIn };
}

/** Width and height a template's parameters imply (the TV's screen size), or null. Inches. */
export function derivedSize(slug: string, params: Record<string, string | number | boolean | undefined>): { wIn: number; hIn: number } | null {
  if (slug === 'tv') {
    const d = Number(params.screenIn ?? 65);
    if (Number.isFinite(d)) return { wIn: Math.round(d * 0.872), hIn: Math.round(d * 0.49) };
  }
  return null;
}
