/** World units are metres. */
export const ROAD_WIDTH = 8;
/** Freehand noise floor, in world units, applied before smoothing. */
export const SIMPLIFY_EPS = 1.6;
export const SMOOTH_PASSES = 2;
/** How close an endpoint must come to an existing node or road to weld onto it. */
export const SNAP_RADIUS = 14;
/** Junctions closer together than this are collapsed into one. */
export const MERGE_DIST = 5;
export const MIN_ROAD_LENGTH = 12;
/** Minimum screen-space spacing between captured stroke samples. */
export const SAMPLE_SPACING_PX = 3;
export const UNDO_LIMIT = 50;

export const COLORS = {
  bg: '#11141a',
  gridMinor: '#191d25',
  gridMajor: '#222832',
  casing: '#272d38',
  road: '#525d70',
  centerline: '#8b97ad',
  node: '#7dd3fc',
  nodeEnd: '#fbbf24',
  stroke: '#38bdf8',
  snap: '#22d3ee',
  erase: '#f87171',
};
