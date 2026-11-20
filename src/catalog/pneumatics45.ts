import type { CatalogComponentDef, ComponentCategory, Domain, PortDefinition } from '../contracts/catalog';

/**
 * Verified ISO 1219 & Festo FluidSIM Pneumatics 4.5 Component Catalog.
 * 23/34 components have empirically verified `fluidsim45Id` class names extracted from
 * real FluidSIM `.ct` files in `fixtures/golden/`. The remaining 11 components keep
 * `fluidsim45IdVerified: false` (never hallucinated) and roundtrip losslessly via
 * `_MCP_TYPE`/`_MCP_PARAMS` in `.ct` and natively in `.fsim.json`.
 */
export const PNEUMATICS_45_CATALOG: readonly CatalogComponentDef[] = [
  // =========================================================================
  // 1. AIR SUPPLY & CONDITIONING
  // =========================================================================
  {
    type: 'air_source',
    fluidsim45Id: 'PPE1',
    fluidsim45IdVerified: true,
    displayName: 'Compressed Air Supply',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'ISO 1219 compressed air pressure source (default 6.0 bar).',
    keywords: ['air', 'supply', 'compressor', 'source', 'pressure', '6 bar'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'supply', required: true, offset: { x: 5, y: 0 } },
    ],
    parameters: [
      { key: 'pressureBar', type: 'number', defaultValue: 6.0, unit: 'bar', min: 0.5, max: 12, description: 'Operating supply pressure' },
      { key: 'maxFlowLMin', type: 'number', defaultValue: 1000, unit: 'l/min', min: 10, max: 5000, description: 'Maximum nominal flow rate' },
    ],
    defaultSize: { width: 10, height: 10 },
    layoutLayer: 4,
  },
  {
    type: 'air_service_unit',
    fluidsim45Id: 'PPE2',
    fluidsim45IdVerified: true,
    displayName: 'Air Service Unit (FRL)',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'Filter, pressure regulator, and lubricator conditioning unit.',
    keywords: ['frl', 'service unit', 'filter', 'regulator', 'conditioning'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'supply', required: true, offset: { x: 0, y: 8 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 20, y: 8 } },
    ],
    parameters: [
      { key: 'nominalPressureBar', type: 'number', defaultValue: 6.0, unit: 'bar', min: 0.5, max: 10, description: 'Regulated outlet pressure' },
    ],
    defaultSize: { width: 20, height: 16 },
    layoutLayer: 4,
  },
  {
    type: 'exhaust_silencer',
    fluidsim45Id: 'PConnection:EX3',
    fluidsim45IdVerified: true,
    displayName: 'Exhaust / Silencer Terminator',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'Pneumatic exhaust port silencer terminator to atmosphere (0 bar gauge).',
    keywords: ['exhaust', 'silencer', 'muffler', 'vent', 'terminator'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'exhaust', required: true, offset: { x: 4, y: 0 } },
    ],
    parameters: [],
    defaultSize: { width: 8, height: 8 },
    layoutLayer: 3,
  },
  {
    type: 'pneumatic_junction',
    fluidsim45Id: 'PTriconnection',
    fluidsim45IdVerified: true,
    displayName: 'Pneumatic T-Junction / Manifold',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'Pneumatic distribution node connecting multiple lines at equal pressure.',
    keywords: ['tee', 'junction', 'manifold', 'branch', 'splitter'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'working', required: true, offset: { x: 0, y: 4 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 8, y: 4 } },
      { name: '3', domain: 'pneumatic', role: 'working', required: false, offset: { x: 4, y: 0 } },
      { name: '4', domain: 'pneumatic', role: 'working', required: false, offset: { x: 4, y: 8 } },
    ],
    parameters: [],
    defaultSize: { width: 8, height: 8 },
    layoutLayer: 3,
  },

  // =========================================================================
  // 2. ACTUATORS
  // =========================================================================
  {
    type: 'cylinder_single_acting',
    fluidsim45Id: 'CylDGPPAB:SA',
    fluidsim45IdVerified: true,
    displayName: 'Single-Acting Cylinder (Spring Return)',
    category: 'actuator',
    domain: 'pneumatic',
    description: 'Single-acting pneumatic cylinder with internal return spring and optional distance rule.',
    keywords: ['cylinder', 'single-acting', 'sac', 'actuator', 'spring return'],
    ports: [
      { name: 'A', domain: 'pneumatic', role: 'working', required: true, offset: { x: 6, y: 18 } },
    ],
    parameters: [
      { key: 'strokeMm', type: 'number', defaultValue: 50, unit: 'mm', min: 5, max: 1000, description: 'Full piston stroke' },
      { key: 'pistonDiameterMm', type: 'number', defaultValue: 20, unit: 'mm', min: 6, max: 200, description: 'Piston bore diameter' },
      { key: 'springForceN', type: 'number', defaultValue: 25, unit: 'N', min: 1, max: 1000, description: 'Internal spring return force' },
      { key: 'externalLoadN', type: 'number', defaultValue: 0, unit: 'N', min: 0, max: 5000, description: 'External opposing load force' },
      { key: 'initialPositionMm', type: 'number', defaultValue: 0, unit: 'mm', min: 0, max: 1000, description: 'Initial piston position' },
    ],
    defaultSize: { width: 42, height: 18 },
    layoutLayer: 0,
    supportsDistanceRule: true,
  },
  {
    type: 'cylinder_double_acting',
    fluidsim45Id: 'CylDGPPAB:DA',
    fluidsim45IdVerified: true,
    displayName: 'Double-Acting Cylinder',
    category: 'actuator',
    domain: 'pneumatic',
    description: 'Double-acting pneumatic cylinder (port A = extend/cap-end, port B = retract/rod-end) with distance rule markers.',
    keywords: ['cylinder', 'double-acting', 'dac', 'actuator', 'piston', 'distance rule'],
    ports: [
      { name: 'A', domain: 'pneumatic', role: 'working', required: true, offset: { x: 6, y: 18 } },
      { name: 'B', domain: 'pneumatic', role: 'working', required: true, offset: { x: 34, y: 18 } },
    ],
    parameters: [
      { key: 'strokeMm', type: 'number', defaultValue: 100, unit: 'mm', min: 5, max: 2000, description: 'Full piston stroke' },
      { key: 'pistonDiameterMm', type: 'number', defaultValue: 25, unit: 'mm', min: 6, max: 250, description: 'Piston bore diameter' },
      { key: 'rodDiameterMm', type: 'number', defaultValue: 10, unit: 'mm', min: 2, max: 120, description: 'Piston rod diameter' },
      { key: 'externalLoadN', type: 'number', defaultValue: 0, unit: 'N', min: 0, max: 10000, description: 'External load force opposing extension' },
      { key: 'cushioning', type: 'boolean', defaultValue: true, description: 'End-position pneumatic cushioning' },
      { key: 'initialPositionMm', type: 'number', defaultValue: 0, unit: 'mm', min: 0, max: 2000, description: 'Initial piston position' },
    ],
    defaultSize: { width: 46, height: 18 },
    layoutLayer: 0,
    supportsDistanceRule: true,
  },

  // =========================================================================
  // 3. DIRECTIONAL CONTROL VALVES (DCVs)
  // =========================================================================
  {
    type: 'valve_3_2',
    fluidsim45Id: 'WV_3',
    fluidsim45IdVerified: true,
    displayName: '3/2-Way Directional Control Valve',
    category: 'directional_valve',
    domain: 'hybrid',
    description: '3/2-way valve (NC or NO) with configurable left/right manual, roller, pilot, solenoid, or spring actuation.',
    keywords: ['3/2', 'valve', 'dcv', 'pushbutton', 'roller', 'limit', 'pilot', 'solenoid'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'supply', required: true, offset: { x: 10, y: 16 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 10, y: 0 } },
      { name: '3', domain: 'pneumatic', role: 'exhaust', required: true, offset: { x: 18, y: 16 } },
      { name: '12', domain: 'pneumatic', role: 'pilot', required: false, offset: { x: 0, y: 8 } },
      { name: '10', domain: 'pneumatic', role: 'pilot', required: false, offset: { x: 26, y: 8 } },
    ],
    parameters: [
      { key: 'normalState', type: 'enum', defaultValue: 'NC', enumValues: ['NC', 'NO'], description: 'Rest position: NC (1 blocked, 2->3) or NO (1->2, 3 blocked)' },
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 120, unit: 'l/min', min: 10, max: 2000, description: 'Nominal conductance flow rate' },
    ],
    defaultSize: { width: 26, height: 16 },
    layoutLayer: 3,
    supportsActuationConfig: true,
  },
  {
    type: 'valve_4_2',
    fluidsim45Id: 'FS45_PENDING_VALVE_4_2',
    fluidsim45IdVerified: false,
    displayName: '4/2-Way Directional Control Valve',
    category: 'directional_valve',
    domain: 'hybrid',
    description: '4/2-way directional control valve with configurable actuation on ports 14 (left) and 12 (right).',
    keywords: ['4/2', 'valve', 'dcv', 'pilot', 'solenoid', 'double-acting'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'supply', required: true, offset: { x: 10, y: 16 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 20, y: 0 } },
      { name: '3', domain: 'pneumatic', role: 'exhaust', required: true, offset: { x: 20, y: 16 } },
      { name: '4', domain: 'pneumatic', role: 'working', required: true, offset: { x: 10, y: 0 } },
      { name: '14', domain: 'pneumatic', role: 'pilot', required: false, offset: { x: 0, y: 8 } },
      { name: '12', domain: 'pneumatic', role: 'pilot', required: false, offset: { x: 30, y: 8 } },
    ],
    parameters: [
      { key: 'initialState', type: 'enum', defaultValue: 'right', enumValues: ['left', 'right'], description: 'Initial spool position (right: 1->2, 4->3; left: 1->4, 2->3)' },
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 400, unit: 'l/min', min: 10, max: 3000, description: 'Nominal flow rate' },
    ],
    defaultSize: { width: 30, height: 16 },
    layoutLayer: 2,
    supportsActuationConfig: true,
  },
  {
    type: 'valve_5_2',
    fluidsim45Id: 'WV_5',
    fluidsim45IdVerified: true,
    displayName: '5/2-Way Directional Control Valve',
    category: 'directional_valve',
    domain: 'hybrid',
    description: '5/2-way directional control valve (memory/bistable or spring-return) with ports 1, 2, 3, 4, 5, 14 (extend), 12 (retract).',
    keywords: ['5/2', 'valve', 'dcv', 'bistable', 'memory', 'pilot', 'solenoid', 'spring'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'supply', required: true, offset: { x: 16, y: 16 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 22, y: 0 } },
      { name: '3', domain: 'pneumatic', role: 'exhaust', required: true, offset: { x: 24, y: 16 } },
      { name: '4', domain: 'pneumatic', role: 'working', required: true, offset: { x: 10, y: 0 } },
      { name: '5', domain: 'pneumatic', role: 'exhaust', required: true, offset: { x: 8, y: 16 } },
      { name: '14', domain: 'pneumatic', role: 'pilot', required: false, offset: { x: 0, y: 8 } },
      { name: '12', domain: 'pneumatic', role: 'pilot', required: false, offset: { x: 32, y: 8 } },
    ],
    parameters: [
      { key: 'initialState', type: 'enum', defaultValue: 'right', enumValues: ['left', 'right'], description: 'Initial spool position (right: 1->2 & 4->5; left: 1->4 & 2->3)' },
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 500, unit: 'l/min', min: 10, max: 3000, description: 'Nominal flow rate' },
    ],
    defaultSize: { width: 32, height: 16 },
    layoutLayer: 2,
    supportsActuationConfig: true,
  },
  {
    type: 'valve_5_3',
    fluidsim45Id: 'FS45_PENDING_VALVE_5_3',
    fluidsim45IdVerified: false,
    displayName: '5/3-Way Directional Control Valve',
    category: 'directional_valve',
    domain: 'hybrid',
    description: '5/3-way spring-centered directional valve with closed, exhausted, or pressurized center position.',
    keywords: ['5/3', 'valve', 'dcv', 'mid-position', 'closed center', 'exhausted center', 'pressurized center'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'supply', required: true, offset: { x: 20, y: 16 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 26, y: 0 } },
      { name: '3', domain: 'pneumatic', role: 'exhaust', required: true, offset: { x: 28, y: 16 } },
      { name: '4', domain: 'pneumatic', role: 'working', required: true, offset: { x: 14, y: 0 } },
      { name: '5', domain: 'pneumatic', role: 'exhaust', required: true, offset: { x: 12, y: 16 } },
      { name: '14', domain: 'pneumatic', role: 'pilot', required: false, offset: { x: 0, y: 8 } },
      { name: '12', domain: 'pneumatic', role: 'pilot', required: false, offset: { x: 40, y: 8 } },
    ],
    parameters: [
      { key: 'centerType', type: 'enum', defaultValue: 'closed', enumValues: ['closed', 'exhausted', 'pressurized'], description: 'Center spring-return state' },
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 450, unit: 'l/min', min: 10, max: 3000, description: 'Nominal flow rate' },
    ],
    defaultSize: { width: 40, height: 16 },
    layoutLayer: 2,
    supportsActuationConfig: true,
  },

  // =========================================================================
  // 4. FLOW, PRESSURE & LOGIC VALVES
  // =========================================================================
  {
    type: 'flow_control_one_way',
    fluidsim45Id: 'DV_P1',
    fluidsim45IdVerified: true,
    displayName: 'One-Way Flow Control Valve (Throttle Check)',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Adjustable throttle with parallel check valve for meter-out or meter-in cylinder speed control.',
    keywords: ['throttle', 'flow control', 'one-way', 'meter-out', 'meter-in', 'speed'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'working', required: true, offset: { x: 8, y: 16 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 8, y: 0 } },
    ],
    parameters: [
      { key: 'openingPct', type: 'number', defaultValue: 50, unit: '%', min: 1, max: 100, description: 'Throttle opening percentage' },
      { key: 'freeFlowDirection', type: 'enum', defaultValue: '1_to_2', enumValues: ['1_to_2', '2_to_1'], description: 'Direction of unrestricted check-valve flow (1_to_2 = meter-out when port 2 faces cylinder)' },
    ],
    defaultSize: { width: 16, height: 16 },
    layoutLayer: 1,
  },
  {
    type: 'quick_exhaust_valve',
    fluidsim45Id: 'FS45_PENDING_QUICK_EXHAUST',
    fluidsim45IdVerified: false,
    displayName: 'Quick Exhaust Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Vents cylinder chamber directly at port 3 when supply at port 1 drops.',
    keywords: ['quick exhaust', 'fast', 'vent', 'speed'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'supply', required: true, offset: { x: 8, y: 16 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 8, y: 0 } },
      { name: '3', domain: 'pneumatic', role: 'exhaust', required: true, offset: { x: 18, y: 8 } },
    ],
    parameters: [],
    defaultSize: { width: 18, height: 16 },
    layoutLayer: 1,
  },
  {
    type: 'shuttle_valve_or',
    fluidsim45Id: 'FS45_PENDING_SHUTTLE_OR',
    fluidsim45IdVerified: false,
    displayName: 'Shuttle Valve (Pneumatic OR)',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Outputs highest pressure from either input port 1 or 1_2 to port 2.',
    keywords: ['shuttle', 'or', 'logic', 'valve'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'working', required: true, offset: { x: 0, y: 8 } },
      { name: '1_2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 20, y: 8 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 10, y: 0 } },
    ],
    parameters: [],
    defaultSize: { width: 20, height: 14 },
    layoutLayer: 3,
  },
  {
    type: 'dual_pressure_valve_and',
    fluidsim45Id: 'FS45_PENDING_DUAL_PRESSURE_AND',
    fluidsim45IdVerified: false,
    displayName: 'Dual-Pressure Valve (Pneumatic AND)',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Outputs pressure at port 2 only when both input ports 1 and 1_2 are pressurized.',
    keywords: ['dual-pressure', 'and', 'two-hand', 'logic', 'valve'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'working', required: true, offset: { x: 0, y: 8 } },
      { name: '1_2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 20, y: 8 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 10, y: 0 } },
    ],
    parameters: [],
    defaultSize: { width: 20, height: 14 },
    layoutLayer: 3,
  },
  {
    type: 'time_delay_valve',
    fluidsim45Id: 'FS45_PENDING_TIME_DELAY',
    fluidsim45IdVerified: false,
    displayName: 'Pneumatic Time-Delay Valve (NC/NO)',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Delays switching of integrated 3/2 valve after pilot 12 is pressurized.',
    keywords: ['timer', 'time-delay', 'delay', 'pneumatic timer'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'supply', required: true, offset: { x: 10, y: 20 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 10, y: 0 } },
      { name: '3', domain: 'pneumatic', role: 'exhaust', required: true, offset: { x: 18, y: 20 } },
      { name: '12', domain: 'pneumatic', role: 'pilot', required: true, offset: { x: 0, y: 10 } },
    ],
    parameters: [
      { key: 'delayMs', type: 'number', defaultValue: 1000, unit: 'ms', min: 10, max: 60000, description: 'Pneumatic switching delay time' },
      { key: 'normalState', type: 'enum', defaultValue: 'NC', enumValues: ['NC', 'NO'], description: 'Rest position before delay elapses' },
    ],
    defaultSize: { width: 26, height: 20 },
    layoutLayer: 3,
  },
  {
    type: 'pressure_sequence_valve',
    fluidsim45Id: 'FS45_PENDING_PRESSURE_SEQUENCE',
    fluidsim45IdVerified: false,
    displayName: 'Pressure Sequence Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Switches integrated 3/2 valve when pilot port 12 reaches configured thresholdBar.',
    keywords: ['pressure sequence', 'pressure switch', 'threshold', 'sequence'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'supply', required: true, offset: { x: 10, y: 20 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 10, y: 0 } },
      { name: '3', domain: 'pneumatic', role: 'exhaust', required: true, offset: { x: 18, y: 20 } },
      { name: '12', domain: 'pneumatic', role: 'pilot', required: true, offset: { x: 0, y: 10 } },
    ],
    parameters: [
      { key: 'thresholdBar', type: 'number', defaultValue: 4.0, unit: 'bar', min: 0.5, max: 10, description: 'Switching pressure threshold' },
    ],
    defaultSize: { width: 26, height: 20 },
    layoutLayer: 3,
  },
  {
    type: 'pressure_regulator',
    fluidsim45Id: 'FS45_PENDING_PRESSURE_REGULATOR',
    fluidsim45IdVerified: false,
    displayName: 'Pressure Regulator Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Limits downstream pressure at port 2 to setPressureBar.',
    keywords: ['regulator', 'pressure reducing', 'bar'],
    ports: [
      { name: '1', domain: 'pneumatic', role: 'supply', required: true, offset: { x: 0, y: 8 } },
      { name: '2', domain: 'pneumatic', role: 'working', required: true, offset: { x: 18, y: 8 } },
    ],
    parameters: [
      { key: 'setPressureBar', type: 'number', defaultValue: 4.0, unit: 'bar', min: 0.5, max: 10, description: 'Regulated downstream pressure' },
    ],
    defaultSize: { width: 18, height: 16 },
    layoutLayer: 3,
  },

  // =========================================================================
  // 5. ELECTRICAL CONTROL (24V / 0V LADDER)
  // =========================================================================
  {
    type: 'power_24v',
    fluidsim45Id: 'pol2',
    fluidsim45IdVerified: true,
    displayName: '+24V DC Power Supply Rail',
    category: 'electrical_power',
    domain: 'electrical',
    description: '+24V DC positive control rail for electro-pneumatic ladder diagrams.',
    keywords: ['24v', '+24v', 'power', 'supply', 'rail', 'dc'],
    ports: [
      { name: 'OUT', domain: 'electrical', role: 'power_pos', required: true, offset: { x: 5, y: 8 } },
    ],
    parameters: [
      { key: 'voltageV', type: 'number', defaultValue: 24, unit: 'V', min: 12, max: 48, description: 'DC rail voltage' },
    ],
    defaultSize: { width: 10, height: 8 },
    layoutLayer: 10,
  },
  {
    type: 'power_0v',
    fluidsim45Id: 'pol1',
    fluidsim45IdVerified: true,
    displayName: '0V DC Common / Ground Rail',
    category: 'electrical_power',
    domain: 'electrical',
    description: '0V DC return rail for electro-pneumatic ladder diagrams.',
    keywords: ['0v', 'ground', 'common', 'return', 'rail', 'dc'],
    ports: [
      { name: 'IN', domain: 'electrical', role: 'power_neg', required: true, offset: { x: 5, y: 0 } },
    ],
    parameters: [],
    defaultSize: { width: 10, height: 8 },
    layoutLayer: 14,
  },
  {
    type: 'electrical_junction',
    fluidsim45Id: 'ETriconnection',
    fluidsim45IdVerified: true,
    displayName: 'Electrical Wire Junction',
    category: 'electrical_power',
    domain: 'electrical',
    description: 'Electrical distribution node connecting parallel ladder branches.',
    keywords: ['junction', 'node', 'branch', 'wire', 'terminal'],
    ports: [
      { name: '1', domain: 'electrical', role: 'signal', required: true, offset: { x: 4, y: 0 } },
      { name: '2', domain: 'electrical', role: 'signal', required: true, offset: { x: 4, y: 8 } },
      { name: '3', domain: 'electrical', role: 'signal', required: false, offset: { x: 0, y: 4 } },
      { name: '4', domain: 'electrical', role: 'signal', required: false, offset: { x: 8, y: 4 } },
    ],
    parameters: [],
    defaultSize: { width: 8, height: 8 },
    layoutLayer: 12,
  },
  {
    type: 'pushbutton_no',
    fluidsim45Id: 'E_S011',
    fluidsim45IdVerified: true,
    displayName: 'Pushbutton (Normally Open)',
    category: 'electrical_switch',
    domain: 'electrical',
    description: 'Normally open pushbutton or detent switch (ports 13, 14).',
    keywords: ['pushbutton', 'start', 'switch', 'no', 'momentary', 'detent'],
    ports: [
      { name: '13', domain: 'electrical', role: 'contact_in', required: true, offset: { x: 5, y: 0 } },
      { name: '14', domain: 'electrical', role: 'contact_out', required: true, offset: { x: 5, y: 14 } },
    ],
    parameters: [
      { key: 'detent', type: 'boolean', defaultValue: false, description: 'If true, stays latched on toggle/press until pressed again' },
    ],
    defaultSize: { width: 10, height: 14 },
    layoutLayer: 11,
  },
  {
    type: 'pushbutton_nc',
    fluidsim45Id: 'E_S012',
    fluidsim45IdVerified: true,
    displayName: 'Pushbutton (Normally Closed)',
    category: 'electrical_switch',
    domain: 'electrical',
    description: 'Normally closed pushbutton or emergency-stop detent switch (ports 11, 12).',
    keywords: ['pushbutton', 'stop', 'estop', 'e-stop', 'switch', 'nc', 'detent'],
    ports: [
      { name: '11', domain: 'electrical', role: 'contact_in', required: true, offset: { x: 5, y: 0 } },
      { name: '12', domain: 'electrical', role: 'contact_out', required: true, offset: { x: 5, y: 14 } },
    ],
    parameters: [
      { key: 'detent', type: 'boolean', defaultValue: false, description: 'If true, latches open on actuation (e.g. mushroom E-stop)' },
    ],
    defaultSize: { width: 10, height: 14 },
    layoutLayer: 11,
  },
  {
    type: 'limit_switch_no',
    fluidsim45Id: 'E_S001:SWITCH_TYPE=1',
    fluidsim45IdVerified: true,
    displayName: 'Limit Switch Contact (NO)',
    category: 'electrical_switch',
    domain: 'electrical',
    description: 'Normally open roller limit switch bound by label to a cylinder distance-rule marker (e.g., a1).',
    keywords: ['limit switch', 'sensor', 'roller', 'no', 'distance rule', 'a0', 'a1'],
    ports: [
      { name: '13', domain: 'electrical', role: 'contact_in', required: true, offset: { x: 5, y: 0 } },
      { name: '14', domain: 'electrical', role: 'contact_out', required: true, offset: { x: 5, y: 14 } },
    ],
    parameters: [],
    defaultSize: { width: 10, height: 14 },
    layoutLayer: 11,
  },
  {
    type: 'limit_switch_nc',
    fluidsim45Id: 'E_S002:SWITCH_TYPE=1',
    fluidsim45IdVerified: true,
    displayName: 'Limit Switch Contact (NC)',
    category: 'electrical_switch',
    domain: 'electrical',
    description: 'Normally closed roller limit switch bound by label to a cylinder distance-rule marker.',
    keywords: ['limit switch', 'sensor', 'roller', 'nc', 'distance rule'],
    ports: [
      { name: '11', domain: 'electrical', role: 'contact_in', required: true, offset: { x: 5, y: 0 } },
      { name: '12', domain: 'electrical', role: 'contact_out', required: true, offset: { x: 5, y: 14 } },
    ],
    parameters: [],
    defaultSize: { width: 10, height: 14 },
    layoutLayer: 11,
  },
  {
    type: 'proximity_switch_magnetic',
    fluidsim45Id: 'FS45_PENDING_PROX_MAGNETIC',
    fluidsim45IdVerified: false,
    displayName: 'Magnetic Proximity Switch (Reed)',
    category: 'electrical_switch',
    domain: 'electrical',
    description: 'Magnetic reed proximity sensor bound by label to a cylinder distance-rule position.',
    keywords: ['proximity', 'magnetic', 'reed', 'sensor', 'cylinder sensor'],
    ports: [
      { name: '13', domain: 'electrical', role: 'contact_in', required: true, offset: { x: 5, y: 0 } },
      { name: '14', domain: 'electrical', role: 'contact_out', required: true, offset: { x: 5, y: 14 } },
    ],
    parameters: [
      { key: 'normalState', type: 'enum', defaultValue: 'NO', enumValues: ['NO', 'NC'], description: 'Contact behavior when piston magnet is absent' },
    ],
    defaultSize: { width: 10, height: 14 },
    layoutLayer: 11,
  },
  {
    type: 'relay_coil',
    fluidsim45Id: 'E_K001',
    fluidsim45IdVerified: true,
    displayName: 'Control Relay Coil (K1..Kn)',
    category: 'electrical_relay',
    domain: 'electrical',
    description: '24V DC control relay coil energizing all relay contacts sharing its label.',
    keywords: ['relay', 'coil', 'k1', 'latch', 'memory'],
    ports: [
      { name: 'A1', domain: 'electrical', role: 'coil_in', required: true, offset: { x: 6, y: 0 } },
      { name: 'A2', domain: 'electrical', role: 'coil_out', required: true, offset: { x: 6, y: 14 } },
    ],
    parameters: [],
    defaultSize: { width: 12, height: 14 },
    layoutLayer: 13,
  },
  {
    type: 'relay_contact_no',
    fluidsim45Id: 'E_S001',
    fluidsim45IdVerified: true,
    displayName: 'Relay Contact (NO)',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Normally open contact actuated by a relay, timer, or counter with the same label.',
    keywords: ['contact', 'relay', 'no', 'make', 'latch'],
    ports: [
      { name: '13', domain: 'electrical', role: 'contact_in', required: true, offset: { x: 5, y: 0 } },
      { name: '14', domain: 'electrical', role: 'contact_out', required: true, offset: { x: 5, y: 14 } },
    ],
    parameters: [],
    defaultSize: { width: 10, height: 14 },
    layoutLayer: 12,
  },
  {
    type: 'relay_contact_nc',
    fluidsim45Id: 'E_S002',
    fluidsim45IdVerified: true,
    displayName: 'Relay Contact (NC)',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Normally closed contact actuated by a relay, timer, or counter with the same label.',
    keywords: ['contact', 'relay', 'nc', 'break', 'interlock'],
    ports: [
      { name: '11', domain: 'electrical', role: 'contact_in', required: true, offset: { x: 5, y: 0 } },
      { name: '12', domain: 'electrical', role: 'contact_out', required: true, offset: { x: 5, y: 14 } },
    ],
    parameters: [],
    defaultSize: { width: 10, height: 14 },
    layoutLayer: 12,
  },
  {
    type: 'relay_contact_changeover',
    fluidsim45Id: 'FS45_PENDING_RELAY_CONTACT_CO',
    fluidsim45IdVerified: false,
    displayName: 'Relay Changeover Contact (SPDT)',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Single-pole double-throw relay contact (11=COM, 12=NC, 14=NO).',
    keywords: ['changeover', 'spdt', 'contact', 'relay'],
    ports: [
      { name: '11', domain: 'electrical', role: 'contact_com', required: true, offset: { x: 6, y: 0 } },
      { name: '12', domain: 'electrical', role: 'contact_nc', required: false, offset: { x: 2, y: 14 } },
      { name: '14', domain: 'electrical', role: 'contact_no', required: false, offset: { x: 10, y: 14 } },
    ],
    parameters: [],
    defaultSize: { width: 12, height: 14 },
    layoutLayer: 12,
  },
  {
    type: 'timer_relay_on_delay',
    fluidsim45Id: 'E_K008',
    fluidsim45IdVerified: true,
    displayName: 'ON-Delay Timer Relay (T1..Tn)',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Energizes linked contacts after coil A1-A2 has been continuously powered for delayMs.',
    keywords: ['timer', 'on-delay', 'ton', 'delay', 'relay'],
    ports: [
      { name: 'A1', domain: 'electrical', role: 'coil_in', required: true, offset: { x: 6, y: 0 } },
      { name: 'A2', domain: 'electrical', role: 'coil_out', required: true, offset: { x: 6, y: 14 } },
    ],
    parameters: [
      { key: 'delayMs', type: 'number', defaultValue: 1000, unit: 'ms', min: 10, max: 600000, description: 'ON-delay duration' },
    ],
    defaultSize: { width: 12, height: 14 },
    layoutLayer: 13,
  },
  {
    type: 'timer_relay_off_delay',
    fluidsim45Id: 'FS45_PENDING_TIMER_OFF',
    fluidsim45IdVerified: false,
    displayName: 'OFF-Delay Timer Relay (T1..Tn)',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Energizes linked contacts immediately on coil power and holds them for delayMs after coil de-energizes.',
    keywords: ['timer', 'off-delay', 'tof', 'delay', 'relay'],
    ports: [
      { name: 'A1', domain: 'electrical', role: 'coil_in', required: true, offset: { x: 6, y: 0 } },
      { name: 'A2', domain: 'electrical', role: 'coil_out', required: true, offset: { x: 6, y: 14 } },
    ],
    parameters: [
      { key: 'delayMs', type: 'number', defaultValue: 1000, unit: 'ms', min: 10, max: 600000, description: 'OFF-delay hold duration' },
    ],
    defaultSize: { width: 12, height: 14 },
    layoutLayer: 13,
  },
  {
    type: 'electrical_counter',
    fluidsim45Id: 'E_P010',
    fluidsim45IdVerified: true,
    displayName: 'Electrical Preset Counter (C1..Cn)',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Counts rising edges on A1-A2 and energizes linked contacts when count reaches presetCount; resets on R1-R2.',
    keywords: ['counter', 'preset', 'cycle counter', 'c1'],
    ports: [
      { name: 'A1', domain: 'electrical', role: 'coil_in', required: true, offset: { x: 4, y: 0 } },
      { name: 'A2', domain: 'electrical', role: 'coil_out', required: true, offset: { x: 4, y: 16 } },
      { name: 'R1', domain: 'electrical', role: 'coil_in', required: false, offset: { x: 12, y: 0 } },
      { name: 'R2', domain: 'electrical', role: 'coil_out', required: false, offset: { x: 12, y: 16 } },
    ],
    parameters: [
      { key: 'presetCount', type: 'number', defaultValue: 3, min: 1, max: 9999, description: 'Target count before output activates' },
    ],
    defaultSize: { width: 16, height: 16 },
    layoutLayer: 13,
  },
  {
    type: 'valve_solenoid',
    fluidsim45Id: 'E_Y001',
    fluidsim45IdVerified: true,
    displayName: 'Valve Solenoid Coil (Y1..Yn)',
    category: 'electrical_actuator',
    domain: 'electrical',
    description: '24V DC solenoid coil bound by label (e.g., Y1) to a pneumatic directional valve pilot.',
    keywords: ['solenoid', 'y1', 'coil', 'valve actuator', 'electro-pneumatic'],
    ports: [
      { name: 'A1', domain: 'electrical', role: 'coil_in', required: true, offset: { x: 6, y: 0 } },
      { name: 'A2', domain: 'electrical', role: 'coil_out', required: true, offset: { x: 6, y: 14 } },
    ],
    parameters: [],
    defaultSize: { width: 12, height: 14 },
    layoutLayer: 13,
  },
  {
    type: 'indicator_lamp',
    fluidsim45Id: 'lampe',
    fluidsim45IdVerified: true,
    displayName: 'Indicator Lamp (H1..Hn)',
    category: 'electrical_actuator',
    domain: 'electrical',
    description: '24V DC status indicator light.',
    keywords: ['lamp', 'light', 'indicator', 'led', 'h1'],
    ports: [
      { name: 'X1', domain: 'electrical', role: 'coil_in', required: true, offset: { x: 6, y: 0 } },
      { name: 'X2', domain: 'electrical', role: 'coil_out', required: true, offset: { x: 6, y: 14 } },
    ],
    parameters: [
      { key: 'color', type: 'enum', defaultValue: 'green', enumValues: ['green', 'red', 'yellow', 'blue', 'white'], description: 'Lamp lens color' },
    ],
    defaultSize: { width: 12, height: 14 },
    layoutLayer: 13,
  },
];

const CATALOG_BY_TYPE = new Map<string, CatalogComponentDef>(
  PNEUMATICS_45_CATALOG.map((def) => [def.type, def]),
);

export function getCatalogComponent(type: string): CatalogComponentDef | undefined {
  return CATALOG_BY_TYPE.get(type);
}

export function getPortDefinition(type: string, portName: string): PortDefinition | undefined {
  const def = CATALOG_BY_TYPE.get(type);
  if (!def) return undefined;
  return def.ports.find((p) => p.name === portName);
}

export function getDefaultParams(type: string): Record<string, number | string | boolean> {
  const def = CATALOG_BY_TYPE.get(type);
  if (!def) return {};
  const out: Record<string, number | string | boolean> = {};
  for (const param of def.parameters) {
    out[param.key] = param.defaultValue;
  }
  return out;
}

export interface CatalogSearchFilter {
  query?: string;
  category?: ComponentCategory;
  domain?: Domain;
  portCount?: number;
  actuationType?: string;
}

export function searchCatalog(filter: CatalogSearchFilter = {}): CatalogComponentDef[] {
  const q = filter.query?.trim().toLowerCase();
  return PNEUMATICS_45_CATALOG.filter((def) => {
    if (filter.category && def.category !== filter.category) return false;
    if (filter.domain && def.domain !== filter.domain) return false;
    if (filter.portCount !== undefined && def.ports.length !== filter.portCount) return false;
    if (filter.actuationType) {
      if (!def.supportsActuationConfig) return false;
    }
    if (q) {
      const hay = [
        def.type,
        def.displayName,
        def.description,
        def.category,
        ...def.keywords,
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function checkCatalogIntegrity(): { ok: boolean; count: number; issues: string[] } {
  const issues: string[] = [];
  const seenTypes = new Set<string>();

  for (const def of PNEUMATICS_45_CATALOG) {
    if (seenTypes.has(def.type)) {
      issues.push(`Duplicate catalog type: ${def.type}`);
    }
    seenTypes.add(def.type);

    const seenPorts = new Set<string>();
    for (const p of def.ports) {
      if (seenPorts.has(p.name)) {
        issues.push(`Duplicate port "${p.name}" on component "${def.type}"`);
      }
      seenPorts.add(p.name);
    }

    const seenParams = new Set<string>();
    for (const param of def.parameters) {
      if (seenParams.has(param.key)) {
        issues.push(`Duplicate param "${param.key}" on component "${def.type}"`);
      }
      seenParams.add(param.key);
    }
  }

  return { ok: issues.length === 0, count: PNEUMATICS_45_CATALOG.length, issues };
}
