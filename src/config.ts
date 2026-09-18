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
/**
 * How much of a bridge, from each end that meets the ground, is a ramp at ground level; the rest
 * is the elevated span. At least the largest junction box (ROUNDABOUT_ZONE), so a junction box at
 * a ramp is always on the ground, and below SNAP_RADIUS, so a stroke end landing on a ramp welds
 * to the ramp's node rather than splitting the ramp.
 */
export const RAMP_LENGTH = 12;
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
export const MAX_ACCEL = 32;
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
/**
 * Speed through a junction with no control (three or more roads, nothing placed on it), 20 km/h.
 * Plain junctions used to cost nothing: cars claimed non-conflicting paths and crossed at full
 * speed, which beat every control. Slowing them is what gives signals, priority roads and
 * roundabouts something to improve on.
 */
export const UNCONTROLLED_SPEED = 5.5;
/**
 * A roundabout's box is bigger than a plain junction's: vehicles enter it this far back from the
 * node, and its ring is `ROUNDABOUT_RING_FRACTION` of that. On short roads the box shrinks to
 * fit (see `LaneNetwork.roundaboutZone`).
 */
export const ROUNDABOUT_ZONE = 12;
export const ROUNDABOUT_RING_FRACTION = 0.6;
/**
 * Entering a roundabout: a car yields to one on the ring that will reach its entry within this
 * arc length (upstream), and keeps this arc length behind one that has just passed it. Together
 * they let cars follow each other round the ring instead of taking turns with the whole box.
 */
export const ROUNDABOUT_YIELD_ARC = 14;
/**
 * ...plus this many seconds of its speed. An entering car may be nearly stopped, so a car on the
 * ring 14 m upstream would be on top of it within a second; the faster the ring car, the further
 * upstream it must be before the entrant can go.
 */
export const ROUNDABOUT_YIELD_TIME = 2;
export const ROUNDABOUT_FOLLOW_ARC = 8;
/**
 * A car that has claimed but not yet reached the ring is still creeping in, so a car behind it
 * keeps `ROUNDABOUT_FOLLOW_ARC` plus this much per metre the claimant still has to travel before
 * joining. Without it a car already on the ring runs up behind an entrant that is not on it yet.
 */
export const ROUNDABOUT_ENTRY_LAG = 4;
/** Speed round a roundabout, 29 km/h: faster than a plain junction, which is the point of it. */
export const ROUNDABOUT_SPEED = 8;
/** A minor-road car yields to a major-road car that is this close to the junction... */
export const YIELD_LOOKAHEAD = 40;
/** ...and always to one waiting this close to the line, moving or not: a standing major-road
 *  queue must not lose its turn to the minor road. */
export const YIELD_QUEUE_DIST = 12;
/** ...and would reach it within this many seconds at its current speed. A car creeping up from
 *  rest does not count, so a minor road is not held for a car that is still a long way off. */
export const YIELD_TIME = 3;
/**
 * A car ahead on the exit lane counts as making room for a follower if it is moving at least
 * this share of its desired speed: it will be clear by the time the follower arrives.
 */
export const EXIT_FLOW_SPEED_FRACTION = 0.5;
/** Seconds ahead used to project a flowing car on the exit lane, about a follower's approach time. */
export const EXIT_LOOKAHEAD = 1;
/** How far along the exit lane everything must be flowing for that projection to be trusted. */
export const EXIT_FLOW_CHECK_LENGTH = 60;
export const MAX_VEHICLES = 300;
/** Cap on trips queued at the entrances. Far beyond it the run has failed long ago anyway. */
export const MAX_WAITING = 400;

// --- demand ---
/** Trip requests per second. Constant: demand does not ramp up over time. */
export const SPAWN_RATE = 1.1;
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

// --- routing ---
/** How often route weights are recomputed from lane heat, and the route cache expires. */
export const ROUTE_REWEIGH_SECONDS = 5;
/**
 * How slowly a route's weight follows a change at each reweigh -- slower than, and separate
 * from, HEAT_TIME_CONSTANT. Without this, every trip planned inside one reweigh window would
 * pile onto whichever road just looked cheaper, jam it by the next window, and swap back the
 * window after.
 */
export const ROUTE_WEIGHT_TIME_CONSTANT = 20;
/** Floor on lane heat used for routing weight, so a jammed lane reads as a severe but finite
 *  penalty rather than making Dijkstra treat it as deleted from the graph. */
export const MIN_ROUTING_HEAT = 0.05;

/**
 * A signal phase runs green, then yellow, then a short all-red before the next phase. A queue
 * discharges about one car per 1.9 s, so 15 s of green passes roughly 8 cars per lane. Longer
 * green passes more per phase but raises delay when traffic is light, since a car arriving at a
 * red waits out more of the other phase.
 */
export const SIGNAL_GREEN_SECONDS = 15;
/** Vehicles that could not stop comfortably still go; everyone further back stops. */
export const SIGNAL_YELLOW_SECONDS = 2;
export const SIGNAL_ALL_RED_SECONDS = 1;

export const COLORS = {
  bg: '#11141a',
  gridMinor: '#191d25',
  gridMajor: '#222832',
  casing: '#272d38',
  road: '#525d70',
  centerline: '#8b97ad',
  /** A bridge deck's edge, lighter than a road's casing so it reads as railings. */
  bridgeRail: '#9aa5b8',
  bridgeShadow: '#000000',
  node: '#7dd3fc',
  nodeEnd: '#fbbf24',
  stroke: '#38bdf8',
  snap: '#22d3ee',
  erase: '#f87171',
  carStopped: '#f87171',
  carSlow: '#fbbf24',
  carFast: '#4ade80',
  junctionBusy: '#fbbf24',
  controlSignal: '#f472b6',
  controlPriority: '#a78bfa',
  controlRoundabout: '#34d399',
  signalGreen: '#4ade80',
  signalYellow: '#fbbf24',
  signalRed: '#f87171',
};
