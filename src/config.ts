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

// --- traffic ---
/** Lane centre distance from the road centreline; roads are ROAD_WIDTH wide, two lanes. */
export const LANE_OFFSET = 2;
export const CAR_LENGTH = 4.4;
export const CAR_WIDTH = 1.9;
/** 50 km/h in m/s. */
export const DESIRED_SPEED = 13.9;
export const SPEED_VARIATION = 0.18;
export const MAX_ACCEL = 1.8;
export const COMFORT_BRAKE = 2.2;
export const MAX_BRAKE = 8;
export const MIN_GAP = 2;
export const TIME_HEADWAY = 1.1;
/** Half-size of the box a vehicle reserves when crossing a junction. */
export const JUNCTION_RADIUS = 5;
/**
 * How close to the junction a vehicle gets before it tries to claim it. Kept short: a vehicle
 * holds the box from here until it has cleared it, so claiming early throttles the junction.
 */
export const JUNCTION_CLAIM_DIST = 8;
/** Deceleration assumed when working out how early a vehicle must claim a junction. */
export const CLAIM_BRAKE = 3.5;
/**
 * How close two junction movements may pass before they count as conflicting. Sits between a
 * vehicle's width and the 2 * LANE_OFFSET separation of opposing lanes, so opposite
 * straight-throughs still run together while near misses at the node do not.
 */
export const MOVEMENT_CLEARANCE = 3;
export const MAX_VEHICLES = 300;

// --- demand ---
/** Seconds per wave; demand steps up at each one. */
export const WAVE_SECONDS = 30;
/** Spawn attempts per second during the first wave. */
export const BASE_SPAWN_RATE = 1.1;
/** Extra share of the base rate added by each wave after the first. */
export const WAVE_GROWTH = 0.35;
/**
 * How many times longer than a free run a journey may average before the network counts as
 * failed. Absolute speed is a poor signal: a busy network settles at a low but steady speed and
 * is still serving everyone. Delay relative to a free run is self-calibrating across networks.
 */
export const FAIL_DELAY_RATIO = 3;
export const FAIL_SECONDS = 20;

// --- feedback ---
/** Seconds of arrivals used for the rolling flow and trip-time figures. */
export const STATS_WINDOW = 60;
/** How quickly the congestion overlay follows a change in speed. */
export const HEAT_TIME_CONSTANT = 3;
/** Lane occupancy at which slow traffic counts as fully congested rather than merely sparse. */
export const HEAT_DENSITY_FULL = 0.4;
export const HISTORY_SAMPLE_SECONDS = 1;
export const HISTORY_LENGTH = 120;
export const SIM_STEP = 1 / 60;
export const MAX_SUBSTEPS = 5;

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
  carStopped: '#f87171',
  carSlow: '#fbbf24',
  carFast: '#4ade80',
  junctionBusy: '#fbbf24',
};
