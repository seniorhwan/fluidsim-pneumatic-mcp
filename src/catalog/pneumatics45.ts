import type { CatalogComponentDef, ComponentCategory, Domain, PortDefinition } from '../contracts/catalog';
import { FLUIDSIM45_PROTOTYPES } from '../codec/prototypes/fluidsim45Prototypes';

/**
 * Verified ISO 1219 & Festo FluidSIM Pneumatics 4.5 Component Catalog (v2 — Prototype-Driven).
 *
 * Every component's `fluidsim45Id`, `fluidsim45IdVerified`, `defaultSize`, and `ports`
 * (including exact offsets and outward exit normals) are derived directly from
 * `FLUIDSIM45_PROTOTYPES` — single source of truth across authoring, layout, routing,
 * simulation, SVG diagnostics, and native `.ct` compilation.
 */

interface CatalogMetaEntry {
  type: string;
  displayName: string;
  category: ComponentCategory;
  domain: Domain;
  description: string;
  keywords: readonly string[];
  parameters: CatalogComponentDef['parameters'];
  layoutLayer: number;
  supportsDistanceRule?: boolean;
  supportsActuationConfig?: boolean;
}

const CATALOG_METADATA: readonly CatalogMetaEntry[] = [
  // =========================================================================
  // 1. AIR SUPPLY, CONDITIONING & DISTRIBUTION
  // =========================================================================
  {
    type: 'air_source',
    displayName: 'Compressed Air Supply',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'ISO 1219 compressed air pressure source (FluidSIM 4.5 PPE1, default 6.0 bar).',
    keywords: ['air', 'supply', 'compressor', 'source', 'pressure', '6 bar', 'ppe1'],
    parameters: [
      { key: 'pressureBar', type: 'number', defaultValue: 6.0, unit: 'bar', min: 0.5, max: 12, description: 'Operating supply pressure' },
      { key: 'maxFlowLMin', type: 'number', defaultValue: 1000, unit: 'l/min', min: 10, max: 5000, description: 'Maximum nominal flow rate' },
    ],
    layoutLayer: 4,
  },
  {
    type: 'air_service_unit',
    displayName: 'Air Service Unit (FRL)',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'Filter, pressure regulator, and lubricator conditioning unit (FluidSIM 4.5 Wartungseinheit2).',
    keywords: ['frl', 'service unit', 'filter', 'regulator', 'conditioning', 'wartungseinheit2'],
    parameters: [
      { key: 'nominalPressureBar', type: 'number', defaultValue: 6.0, unit: 'bar', min: 0.5, max: 10, description: 'Regulated outlet pressure' },
    ],
    layoutLayer: 4,
  },
  {
    type: 'air_filter',
    displayName: 'Air Filter (Standalone)',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'Standalone inline pneumatic/vacuum air filter element (FluidSIM 4.5 FilterP).',
    keywords: ['filter', 'air filter', 'vacuum filter', 'conditioning', 'inline', 'filterp'],
    parameters: [
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 500, unit: 'l/min', min: 10, max: 5000, description: 'Nominal filter conductance flow rate' },
    ],
    layoutLayer: 1,
  },
  {
    type: 'air_reservoir',
    displayName: 'Compressed Air Reservoir / Tank',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'Pneumatic air buffer vessel / pressure accumulator (FluidSIM 4.5 AccPneu1).',
    keywords: ['reservoir', 'tank', 'accumulator', 'buffer', 'vessel', 'accpneu1'],
    parameters: [
      { key: 'volumeL', type: 'number', defaultValue: 1.0, unit: 'l', min: 0.01, max: 100, description: 'Internal reservoir volume' },
    ],
    layoutLayer: 3,
  },
  {
    type: 'exhaust_silencer',
    displayName: 'Exhaust / Silencer Terminator',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'Pneumatic exhaust silencer terminator to atmosphere (prefer inline portTerminators in IR v2).',
    keywords: ['exhaust', 'silencer', 'muffler', 'vent', 'terminator', 'ex3'],
    parameters: [],
    layoutLayer: 3,
  },
  {
    type: 'blind_plug',
    displayName: 'Blind Plug / Port Blanking Terminator',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'Pneumatic port blanking plug terminator (prefer inline portTerminators in IR v2).',
    keywords: ['blind plug', 'plug', 'cap', 'blanking', 'terminator', 'ex4'],
    parameters: [],
    layoutLayer: 3,
  },
  {
    type: 'pneumatic_junction',
    displayName: 'Pneumatic T-Junction',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'FluidSIM 4.5 3-gate pneumatic T-junction (PTriconnection; prefer named nets[] in IR v2).',
    keywords: ['junction', 'tee', 'splitter', 'branch', 'ptriconnection'],
    parameters: [],
    layoutLayer: 3,
  },
  {
    type: 'pneumatic_manifold',
    displayName: 'Pneumatic Distribution Manifold / Bus',
    category: 'air_supply',
    domain: 'pneumatic',
    description: 'Multi-port pneumatic distribution manifold lowered to 3-gate PTriconnection bus tree.',
    keywords: ['manifold', 'bus', 'rail', 'header', 'distribution', 'cpv10'],
    parameters: [
      { key: 'busRole', type: 'enum', defaultValue: 'supply', enumValues: ['supply', 'exhaust', 'signal'], description: 'Functional manifold bus role' },
    ],
    layoutLayer: 3,
  },

  // =========================================================================
  // 2. LINEAR & ROTARY ACTUATORS
  // =========================================================================
  {
    type: 'cylinder_single_acting',
    displayName: 'Single-Acting Cylinder (Spring Return)',
    category: 'actuator',
    domain: 'pneumatic',
    description: 'Single-acting pneumatic cylinder with internal return spring (FluidSIM 4.5 CylDGPPAB).',
    keywords: ['cylinder', 'single acting', 'spring return', 'actuator', 'linear'],
    parameters: [
      { key: 'strokeMm', type: 'number', defaultValue: 50, unit: 'mm', min: 5, max: 2000, description: 'Piston stroke length' },
      { key: 'pistonDiameterMm', type: 'number', defaultValue: 20, unit: 'mm', min: 6, max: 320, description: 'Piston bore diameter' },
      { key: 'springForceN', type: 'number', defaultValue: 25, unit: 'N', min: 1, max: 2000, description: 'Return spring force' },
      { key: 'externalLoadN', type: 'number', defaultValue: 0, unit: 'N', min: -5000, max: 5000, description: 'Opposing external load force' },
      { key: 'initialPositionMm', type: 'number', defaultValue: 0, unit: 'mm', min: 0, max: 2000, description: 'Initial piston position' },
    ],
    layoutLayer: 0,
    supportsDistanceRule: true,
  },
  {
    type: 'cylinder_double_acting',
    displayName: 'Double-Acting Cylinder',
    category: 'actuator',
    domain: 'pneumatic',
    description: 'Double-acting pneumatic cylinder with magnetic piston & cushioning (FluidSIM 4.5 CylDGPPAB).',
    keywords: ['cylinder', 'double acting', 'actuator', 'linear', 'piston'],
    parameters: [
      { key: 'strokeMm', type: 'number', defaultValue: 100, unit: 'mm', min: 5, max: 2000, description: 'Piston stroke length' },
      { key: 'pistonDiameterMm', type: 'number', defaultValue: 25, unit: 'mm', min: 6, max: 320, description: 'Piston bore diameter' },
      { key: 'rodDiameterMm', type: 'number', defaultValue: 10, unit: 'mm', min: 2, max: 160, description: 'Piston rod diameter' },
      { key: 'externalLoadN', type: 'number', defaultValue: 0, unit: 'N', min: -5000, max: 5000, description: 'Opposing external load force' },
      { key: 'cushioning', type: 'boolean', defaultValue: true, description: 'Adjustable end-position cushioning' },
      { key: 'initialPositionMm', type: 'number', defaultValue: 0, unit: 'mm', min: 0, max: 2000, description: 'Initial piston position' },
    ],
    layoutLayer: 0,
    supportsDistanceRule: true,
  },
  {
    type: 'cylinder_rodless',
    displayName: 'Rodless Linear Drive Cylinder',
    category: 'actuator',
    domain: 'pneumatic',
    description: 'Double-acting rodless carriage linear drive (FluidSIM 4.5 CylDGPPAB SLEDGE=T).',
    keywords: ['rodless', 'linear drive', 'carriage', 'sledge', 'cylinder', 'testing station'],
    parameters: [
      { key: 'strokeMm', type: 'number', defaultValue: 200, unit: 'mm', min: 10, max: 3000, description: 'Carriage stroke length' },
      { key: 'pistonDiameterMm', type: 'number', defaultValue: 25, unit: 'mm', min: 8, max: 100, description: 'Bore diameter' },
      { key: 'externalLoadN', type: 'number', defaultValue: 0, unit: 'N', min: -5000, max: 5000, description: 'Opposing load force' },
      { key: 'initialPositionMm', type: 'number', defaultValue: 0, unit: 'mm', min: 0, max: 3000, description: 'Initial carriage position' },
    ],
    layoutLayer: 0,
    supportsDistanceRule: true,
  },
  {
    type: 'swivel_drive',
    displayName: 'Semi-Rotary Swivel Drive',
    category: 'actuator',
    domain: 'pneumatic',
    description: 'Pneumatic semi-rotary vane/swivel drive (FluidSIM 4.5 PAR1b, 0..180 deg).',
    keywords: ['swivel', 'rotary', 'semi-rotary', 'vane', 'actuator', 'par1b'],
    parameters: [
      { key: 'maxAngleDeg', type: 'number', defaultValue: 180, unit: 'deg', min: 30, max: 360, description: 'Maximum swivel angle' },
      { key: 'initialAngleDeg', type: 'number', defaultValue: 0, unit: 'deg', min: 0, max: 360, description: 'Initial swivel angle' },
      { key: 'torqueNm', type: 'number', defaultValue: 5, unit: 'Nm', min: 0.1, max: 500, description: 'Rated drive torque' },
      { key: 'externalLoadNm', type: 'number', defaultValue: 0, unit: 'Nm', min: -500, max: 500, description: 'Opposing torque load' },
    ],
    layoutLayer: 0,
    supportsDistanceRule: true,
  },
  {
    type: 'air_motor',
    displayName: 'Pneumatic Air Motor',
    category: 'actuator',
    domain: 'pneumatic',
    description: 'Bidirectional rotary pneumatic air motor (FluidSIM 4.5 PAR2).',
    keywords: ['motor', 'air motor', 'rotary', 'par2'],
    parameters: [
      { key: 'nominalRpm', type: 'number', defaultValue: 1200, unit: 'rpm', min: 10, max: 20000, description: 'Nominal rotational speed' },
    ],
    layoutLayer: 0,
  },

  // =========================================================================
  // 3. VACUUM TECHNOLOGY
  // =========================================================================
  {
    type: 'vacuum_suction_nozzle',
    displayName: 'Vacuum Suction Nozzle (Venturi Ejector)',
    category: 'vacuum',
    domain: 'pneumatic',
    description: 'Venturi vacuum generator producing negative pressure on port 1v (FluidSIM 4.5 PAV1).',
    keywords: ['vacuum', 'venturi', 'ejector', 'suction nozzle', 'pav1'],
    parameters: [
      { key: 'vacuumBar', type: 'number', defaultValue: -0.7, unit: 'bar', min: -0.95, max: -0.1, description: 'Generated vacuum pressure' },
      { key: 'minSupplyBar', type: 'number', defaultValue: 3.0, unit: 'bar', min: 1.0, max: 8.0, description: 'Minimum supply pressure for vacuum' },
    ],
    layoutLayer: 1,
  },
  {
    type: 'vacuum_sucker',
    displayName: 'Vacuum Suction Cup / Sucker',
    category: 'vacuum',
    domain: 'pneumatic',
    description: 'Vacuum gripper suction cup actuated by negative pressure on port 1v (FluidSIM 4.5 PAV1S).',
    keywords: ['vacuum', 'sucker', 'suction cup', 'gripper', 'pav1s'],
    parameters: [
      { key: 'gripThresholdBar', type: 'number', defaultValue: -0.3, unit: 'bar', min: -0.95, max: -0.05, description: 'Vacuum threshold for workpiece grip' },
    ],
    layoutLayer: 0,
  },

  // =========================================================================
  // 4. DIRECTIONAL CONTROL VALVES
  // =========================================================================
  {
    type: 'valve_2_2',
    displayName: '2/2-Way Directional Valve',
    category: 'directional_valve',
    domain: 'hybrid',
    description: '2/2-way configurable valve with authentic FluidSIM 4.5 WV_2 solver compilation.',
    keywords: ['valve', '2/2', 'wv_2', 'directional', 'shutoff', 'solenoid'],
    parameters: [
      { key: 'normalState', type: 'enum', defaultValue: 'NC', enumValues: ['NC', 'NO'], description: 'Normal resting flow state' },
      { key: 'normallyOpen', type: 'boolean', defaultValue: false, description: 'True when normally open at rest' },
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 200, unit: 'l/min', min: 10, max: 5000, description: 'Nominal valve flow rate' },
    ],
    layoutLayer: 2,
    supportsActuationConfig: true,
  },
  {
    type: 'valve_3_2',
    displayName: '3/2-Way Directional Valve',
    category: 'directional_valve',
    domain: 'hybrid',
    description: '3/2-way configurable valve (NC or NO) with authentic FluidSIM 4.5 WV_3 solver compilation.',
    keywords: ['valve', '3/2', 'wv_3', 'directional', 'pushbutton', 'roller', 'solenoid'],
    parameters: [
      { key: 'normalState', type: 'enum', defaultValue: 'NC', enumValues: ['NC', 'NO'], description: 'Normal resting flow state' },
      { key: 'normallyOpen', type: 'boolean', defaultValue: false, description: 'True when normally open (1->2 at rest)' },
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 120, unit: 'l/min', min: 10, max: 5000, description: 'Nominal valve flow rate' },
    ],
    layoutLayer: 3,
    supportsActuationConfig: true,
  },
  {
    type: 'valve_4_2',
    displayName: '4/2-Way Directional Valve',
    category: 'directional_valve',
    domain: 'hybrid',
    description: '4/2-way directional control valve with authentic FluidSIM 4.5 WV_4 solver compilation.',
    keywords: ['valve', '4/2', 'wv_4', 'directional', 'double acting'],
    parameters: [
      { key: 'initialState', type: 'enum', defaultValue: 'right', enumValues: ['left', 'right'], description: 'Initial spool position' },
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 400, unit: 'l/min', min: 10, max: 5000, description: 'Nominal valve flow rate' },
    ],
    layoutLayer: 2,
    supportsActuationConfig: true,
  },
  {
    type: 'valve_5_2',
    displayName: '5/2-Way Directional Valve',
    category: 'directional_valve',
    domain: 'hybrid',
    description: '5/2-way directional control valve (monostable/bistable) with authentic FluidSIM 4.5 WV_5 solver compilation.',
    keywords: ['valve', '5/2', 'wv_5', 'directional', 'memory', 'solenoid', 'pilot'],
    parameters: [
      { key: 'initialState', type: 'enum', defaultValue: 'right', enumValues: ['left', 'right'], description: 'Initial spool position' },
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 500, unit: 'l/min', min: 10, max: 5000, description: 'Nominal valve flow rate' },
    ],
    layoutLayer: 2,
    supportsActuationConfig: true,
  },
  {
    type: 'valve_5_3',
    displayName: '5/3-Way Directional Valve',
    category: 'directional_valve',
    domain: 'hybrid',
    description: '5/3-way mid-position valve (closed, exhaust, or pressurized center) compiled to FluidSIM 4.5 WV_5.',
    keywords: ['valve', '5/3', 'wv_5', 'mid-position', 'closed center', 'exhaust center'],
    parameters: [
      { key: 'centerType', type: 'enum', defaultValue: 'closed', enumValues: ['closed', 'exhaust', 'pressurized'], description: 'Center spool behavior' },
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 450, unit: 'l/min', min: 10, max: 5000, description: 'Nominal valve flow rate' },
    ],
    layoutLayer: 2,
    supportsActuationConfig: true,
  },

  // =========================================================================
  // 5. FLOW, SHUT-OFF, LOGIC & PRESSURE VALVES
  // =========================================================================
  {
    type: 'flow_control_one_way',
    displayName: 'One-Way Flow Control Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Meter-out/meter-in adjustable throttle with bypass check valve (FluidSIM 4.5 DRSV2_pneu).',
    keywords: ['flow control', 'one way', 'throttle', 'speed control', 'meter out', 'drsv2_pneu'],
    parameters: [
      { key: 'openingPct', type: 'number', defaultValue: 50, unit: '%', min: 1, max: 100, description: 'Throttle opening percentage' },
      { key: 'freeFlowDirection', type: 'enum', defaultValue: '1_to_2', enumValues: ['1_to_2', '2_to_1'], description: 'Unthrottled check-valve bypass direction' },
    ],
    layoutLayer: 1,
  },
  {
    type: 'throttle_valve',
    displayName: 'Adjustable Throttle Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Bidirectional adjustable pneumatic throttle valve (FluidSIM 4.5 DV_P1).',
    keywords: ['throttle', 'restrictor', 'flow', 'dv_p1'],
    parameters: [
      { key: 'openingPct', type: 'number', defaultValue: 50, unit: '%', min: 1, max: 100, description: 'Throttle opening percentage' },
    ],
    layoutLayer: 1,
  },
  {
    type: 'nozzle',
    displayName: 'Fixed Pneumatic Nozzle / Air Cushion Orifice',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Fixed pneumatic air nozzle / orifice restrictor (FluidSIM 4.5 NozzleP, sym/pneu/sfv/pth1.ct).',
    keywords: ['nozzle', 'orifice', 'air cushion', 'jet', 'nozzlep', 'testing station'],
    parameters: [
      { key: 'openingPct', type: 'number', defaultValue: 50, unit: '%', min: 1, max: 100, description: 'Orifice opening percentage' },
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 40, unit: 'l/min', min: 1, max: 2000, description: 'Fixed orifice conductance' },
      { key: 'diameterMm', type: 'number', defaultValue: 0.8, unit: 'mm', min: 0.1, max: 10, description: 'Nozzle bore diameter' },
    ],
    layoutLayer: 1,
  },
  {
    type: 'orifice',
    displayName: 'Calibrated Pneumatic Orifice',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Calibrated fixed pneumatic restrictor orifice (FluidSIM 4.5 NozzleP).',
    keywords: ['orifice', 'restrictor', 'nozzle', 'nozzlep'],
    parameters: [
      { key: 'openingPct', type: 'number', defaultValue: 50, unit: '%', min: 1, max: 100, description: 'Orifice opening percentage' },
      { key: 'nominalFlowLMin', type: 'number', defaultValue: 40, unit: 'l/min', min: 1, max: 2000, description: 'Fixed orifice conductance' },
    ],
    layoutLayer: 1,
  },
  {
    type: 'check_valve',
    displayName: 'Non-Return Check Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Inline non-return check valve allowing flow 1 -> 2 (FluidSIM 4.5 CheckValveP).',
    keywords: ['check', 'non-return', 'one-way', 'checkvalvep'],
    parameters: [
      { key: 'crackingPressureBar', type: 'number', defaultValue: 0.1, unit: 'bar', min: 0, max: 5, description: 'Forward opening pressure' },
    ],
    layoutLayer: 1,
  },
  {
    type: 'check_valve_spring',
    displayName: 'Spring-Loaded Check Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Spring-loaded non-return check valve (FluidSIM 4.5 CheckValveSpringLoadedP).',
    keywords: ['check', 'spring check', 'non-return', 'checkvalvespringloadedp'],
    parameters: [
      { key: 'crackingPressureBar', type: 'number', defaultValue: 0.3, unit: 'bar', min: 0, max: 5, description: 'Spring cracking pressure' },
    ],
    layoutLayer: 1,
  },
  {
    type: 'check_valve_pilot_open',
    displayName: 'Pilot-Operated Spring-Loaded Check Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Delockable pilot-operated spring-loaded check valve unlocked by pilot port 12 (FluidSIM 4.5 CheckValvePilotOperatedSpringLoadedP, sf5d.ct).',
    keywords: ['pilot check', 'delockable', 'stop valve', 'checkvalvepilotoperatedspringloadedp', 'testing station'],
    parameters: [
      { key: 'crackingPressureBar', type: 'number', defaultValue: 0.2, unit: 'bar', min: 0, max: 5, description: 'Forward spring cracking pressure' },
      { key: 'pilotUnlockBar', type: 'number', defaultValue: 1.5, unit: 'bar', min: 0.2, max: 8, description: 'Minimum pilot pressure on port 12 to unlock reverse flow 2 -> 1' },
    ],
    layoutLayer: 1,
  },
  {
    type: 'quick_exhaust_valve',
    displayName: 'Quick Exhaust Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'High-flow quick exhaust valve venting port 2 directly to port 3 (FluidSIM 4.5 PVS2).',
    keywords: ['quick exhaust', 'fast exhaust', 'pvs2', 'sf3'],
    parameters: [],
    layoutLayer: 1,
  },
  {
    type: 'shuttle_valve_or',
    displayName: 'Shuttle Valve (Pneumatic OR)',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Pneumatic OR logic shuttle valve passing max(1, 1_2) to port 2 (FluidSIM 4.5 PVS3).',
    keywords: ['shuttle', 'or', 'logic', 'pvs3', 'sf2'],
    parameters: [],
    layoutLayer: 3,
  },
  {
    type: 'dual_pressure_valve_and',
    displayName: 'Dual-Pressure Valve (Pneumatic AND)',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Pneumatic AND logic dual-pressure valve passing min(1, 1_2) to port 2 (FluidSIM 4.5 PVS1).',
    keywords: ['dual pressure', 'and', 'logic', 'two-hand', 'pvs1', 'sf1'],
    parameters: [],
    layoutLayer: 3,
  },
  {
    type: 'time_delay_valve',
    displayName: 'Pneumatic Time-Delay Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Pneumatic on-delay timer valve (FluidSIM 4.5 TimerClosedP).',
    keywords: ['timer', 'delay', 'time delay', 'dwell', 'timerclosedp'],
    parameters: [
      { key: 'delayMs', type: 'number', defaultValue: 1000, unit: 'ms', min: 50, max: 60000, description: 'Delay duration before switching' },
      { key: 'normalState', type: 'enum', defaultValue: 'NC', enumValues: ['NC', 'NO'], description: 'Normal resting state' },
    ],
    layoutLayer: 3,
  },
  {
    type: 'pressure_sequence_valve',
    displayName: 'Pressure Sequence Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Switches output port 2 when pilot pressure on port 12 exceeds thresholdBar.',
    keywords: ['pressure sequence', 'threshold', 'sequence'],
    parameters: [
      { key: 'thresholdBar', type: 'number', defaultValue: 4.0, unit: 'bar', min: 0.5, max: 12, description: 'Switching threshold pressure' },
    ],
    layoutLayer: 3,
  },
  {
    type: 'pressure_regulator',
    displayName: 'Adjustable Pressure Regulator',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: '3-way adjustable pressure reducing valve (FluidSIM 4.5 PressureReducingValve3WaysAdjustableP).',
    keywords: ['regulator', 'pressure reducing', 'reducer'],
    parameters: [
      { key: 'setPressureBar', type: 'number', defaultValue: 4.0, unit: 'bar', min: 0.2, max: 10, description: 'Regulated outlet pressure' },
    ],
    layoutLayer: 3,
  },
  {
    type: 'pressure_relief_valve',
    displayName: 'Pressure Relief Valve',
    category: 'flow_pressure_logic',
    domain: 'pneumatic',
    description: 'Safety pressure relief valve venting above reliefPressureBar.',
    keywords: ['relief', 'safety valve', 'overpressure'],
    parameters: [
      { key: 'reliefPressureBar', type: 'number', defaultValue: 6.5, unit: 'bar', min: 0.5, max: 15, description: 'Opening relief pressure' },
    ],
    layoutLayer: 3,
  },

  // =========================================================================
  // 6. MEASURING & SENSORS
  // =========================================================================
  {
    type: 'pressure_switch_differential',
    displayName: 'Vacuum / Differential Pressure Switch (PSW1)',
    category: 'measuring',
    domain: 'hybrid',
    description: 'Adjustable vacuum/pressure switch (FluidSIM 4.5 PSW1).',
    keywords: ['pressure switch', 'vacuum switch', 'differential', 'psw1', 'sensor'],
    parameters: [
      { key: 'pressureBar', type: 'number', defaultValue: -0.5, unit: 'bar', min: -1.0, max: 12.0, description: 'Switching setpoint pressure' },
      { key: 'hysteresisBar', type: 'number', defaultValue: 0.05, unit: 'bar', min: 0, max: 2, description: 'Switching hysteresis band' },
      { key: 'triggerMode', type: 'enum', defaultValue: 'auto', enumValues: ['auto', 'above', 'below'], description: 'Trigger above or below threshold' },
    ],
    layoutLayer: 1,
  },
  {
    type: 'pressure_switch_pew',
    displayName: 'Pneumatic-Electrical Pressure Converter (PEW)',
    category: 'measuring',
    domain: 'hybrid',
    description: 'Differential pneumatic-to-electrical pressure switch (FluidSIM 4.5 PEW, ps2.ct).',
    keywords: ['pew', 'pressure switch', 'converter', 'differential', 'sensor'],
    parameters: [
      { key: 'pressureBar', type: 'number', defaultValue: 3.0, unit: 'bar', min: -1.0, max: 12.0, description: 'Switching setpoint pressure' },
      { key: 'hysteresisBar', type: 'number', defaultValue: 0.05, unit: 'bar', min: 0, max: 2, description: 'Switching hysteresis band' },
      { key: 'triggerMode', type: 'enum', defaultValue: 'auto', enumValues: ['auto', 'above', 'below'], description: 'Trigger above or below threshold' },
    ],
    layoutLayer: 1,
  },
  {
    type: 'pressure_gauge',
    displayName: 'Pneumatic Pressure Gauge (Manometer)',
    category: 'measuring',
    domain: 'pneumatic',
    description: 'Visual pneumatic pressure indicator / manometer (FluidSIM 4.5 PressureIndicatorP).',
    keywords: ['gauge', 'manometer', 'indicator', 'pressure', 'pressureindicatorp'],
    parameters: [
      { key: 'minBar', type: 'number', defaultValue: -1, unit: 'bar', min: -1, max: 0, description: 'Scale minimum' },
      { key: 'maxBar', type: 'number', defaultValue: 10, unit: 'bar', min: 1, max: 20, description: 'Scale maximum' },
    ],
    layoutLayer: 1,
  },

  // =========================================================================
  // 7. ELECTRICAL 24V / 0V LADDER CONTROL
  // =========================================================================
  {
    type: 'power_24v',
    displayName: '+24V DC Power Supply Rail',
    category: 'electrical_power',
    domain: 'electrical',
    description: '24V DC positive control rail (FluidSIM 4.5 pol2).',
    keywords: ['24v', 'power', 'rail', 'vcc', 'supply', 'pol2'],
    parameters: [
      { key: 'voltageV', type: 'number', defaultValue: 24, unit: 'V', min: 5, max: 48, description: 'DC supply voltage' },
    ],
    layoutLayer: 10,
  },
  {
    type: 'power_0v',
    displayName: '0V DC Return Rail',
    category: 'electrical_power',
    domain: 'electrical',
    description: '0V DC ground/return rail (FluidSIM 4.5 pol1).',
    keywords: ['0v', 'gnd', 'ground', 'return', 'rail', 'pol1'],
    parameters: [],
    layoutLayer: 14,
  },
  {
    type: 'electrical_junction',
    displayName: 'Electrical T-Junction',
    category: 'electrical_power',
    domain: 'electrical',
    description: 'FluidSIM 4.5 3-gate electrical T-junction (ETriconnection; prefer named nets[] in IR v2).',
    keywords: ['junction', 'node', 'tee', 'etriconnection'],
    parameters: [],
    layoutLayer: 12,
  },
  {
    type: 'pushbutton_no',
    displayName: 'Pushbutton Switch (NO)',
    category: 'electrical_switch',
    domain: 'electrical',
    description: 'Normally-open electrical pushbutton or detent switch (FluidSIM 4.5 E_S011).',
    keywords: ['pushbutton', 'start', 'switch', 'no', 'e_s011'],
    parameters: [
      { key: 'detent', type: 'boolean', defaultValue: false, description: 'Latching detent toggle switch when true' },
    ],
    layoutLayer: 11,
  },
  {
    type: 'pushbutton_nc',
    displayName: 'Pushbutton Switch (NC / Stop / E-Stop)',
    category: 'electrical_switch',
    domain: 'electrical',
    description: 'Normally-closed electrical stop or emergency-stop switch (FluidSIM 4.5 E_S012).',
    keywords: ['pushbutton', 'stop', 'estop', 'nc', 'e_s012'],
    parameters: [
      { key: 'detent', type: 'boolean', defaultValue: false, description: 'Latching detent emergency stop when true' },
    ],
    layoutLayer: 11,
  },
  {
    type: 'limit_switch_no',
    displayName: 'Limit Switch (NO)',
    category: 'electrical_switch',
    domain: 'electrical',
    description: 'Normally-open mechanical limit switch bound to a cylinder distanceRule marker (FluidSIM 4.5 E_S001).',
    keywords: ['limit switch', 'sensor', 'roller', 'no', 'distance rule'],
    parameters: [],
    layoutLayer: 11,
  },
  {
    type: 'limit_switch_nc',
    displayName: 'Limit Switch (NC)',
    category: 'electrical_switch',
    domain: 'electrical',
    description: 'Normally-closed mechanical limit switch bound to a cylinder distanceRule marker (FluidSIM 4.5 E_S002).',
    keywords: ['limit switch', 'sensor', 'nc', 'distance rule'],
    parameters: [],
    layoutLayer: 11,
  },
  {
    type: 'proximity_switch_magnetic',
    displayName: 'Magnetic Proximity Switch (Reed)',
    category: 'electrical_switch',
    domain: 'electrical',
    description: 'Magnetic reed cylinder proximity sensor (FluidSIM 4.5 E_B001).',
    keywords: ['proximity', 'magnetic', 'reed', 'sensor', 'e_b001'],
    parameters: [
      { key: 'normalState', type: 'enum', defaultValue: 'NO', enumValues: ['NO', 'NC'], description: 'Normal switch state' },
    ],
    layoutLayer: 11,
  },
  {
    type: 'relay_coil',
    displayName: 'Control Relay Coil',
    category: 'electrical_relay',
    domain: 'electrical',
    description: '24V DC electromechanical relay coil K1..Kn (FluidSIM 4.5 E_K001).',
    keywords: ['relay', 'coil', 'k1', 'e_k001'],
    parameters: [],
    layoutLayer: 13,
  },
  {
    type: 'relay_contact_no',
    displayName: 'Relay Make Contact (NO)',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Normally-open relay/timer/counter contact (FluidSIM 4.5 E_S001).',
    keywords: ['contact', 'make', 'no', 'relay'],
    parameters: [],
    layoutLayer: 12,
  },
  {
    type: 'relay_contact_nc',
    displayName: 'Relay Break Contact (NC)',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Normally-closed relay/timer/counter contact (FluidSIM 4.5 E_S002).',
    keywords: ['contact', 'break', 'nc', 'relay'],
    parameters: [],
    layoutLayer: 12,
  },
  {
    type: 'relay_contact_changeover',
    displayName: 'Relay Changeover Contact (SPDT)',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Changeover SPDT relay contact 11-12/14 (FluidSIM 4.5 LWechsler).',
    keywords: ['changeover', 'spdt', 'contact', 'lwechsler'],
    parameters: [],
    layoutLayer: 12,
  },
  {
    type: 'timer_relay_on_delay',
    displayName: 'On-Delay Timer Relay',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Electrical on-delay timer relay coil (FluidSIM 4.5 E_K008).',
    keywords: ['timer', 'on delay', 'dwell', 'e_k008'],
    parameters: [
      { key: 'delayMs', type: 'number', defaultValue: 1000, unit: 'ms', min: 10, max: 60000, description: 'On-delay time in ms' },
    ],
    layoutLayer: 13,
  },
  {
    type: 'timer_relay_off_delay',
    displayName: 'Off-Delay Timer Relay',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Electrical off-delay timer relay coil (FluidSIM 4.5 LRelaismagnet_abfver).',
    keywords: ['timer', 'off delay', 'lrelaismagnet_abfver'],
    parameters: [
      { key: 'delayMs', type: 'number', defaultValue: 1000, unit: 'ms', min: 10, max: 60000, description: 'Off-delay time in ms' },
    ],
    layoutLayer: 13,
  },
  {
    type: 'electrical_counter',
    displayName: 'Electrical Preset Counter',
    category: 'electrical_relay',
    domain: 'electrical',
    description: 'Electrical decrementing preset counter with reset coil (FluidSIM 4.5 E_P010).',
    keywords: ['counter', 'preset', 'cycle count', 'e_p010'],
    parameters: [
      { key: 'presetCount', type: 'number', defaultValue: 3, min: 1, max: 9999, description: 'Target count threshold' },
    ],
    layoutLayer: 13,
  },
  {
    type: 'valve_solenoid',
    displayName: 'Valve Solenoid Coil',
    category: 'electrical_actuator',
    domain: 'electrical',
    description: '24V DC valve solenoid actuator coil bound by label to a directional valve (FluidSIM 4.5 E_Y001).',
    keywords: ['solenoid', 'coil', 'y1', 'valve', 'e_y001'],
    parameters: [],
    layoutLayer: 13,
  },
  {
    type: 'indicator_lamp',
    displayName: 'Indicator Lamp',
    category: 'electrical_actuator',
    domain: 'electrical',
    description: '24V DC status indicator lamp (FluidSIM 4.5 E_H001).',
    keywords: ['lamp', 'light', 'indicator', 'pilot light', 'e_h001'],
    parameters: [
      { key: 'color', type: 'enum', defaultValue: 'green', enumValues: ['green', 'red', 'yellow', 'blue', 'white'], description: 'Lamp lens color' },
    ],
    layoutLayer: 13,
  },
];

export const PNEUMATICS_45_CATALOG: readonly CatalogComponentDef[] = CATALOG_METADATA.map((meta) => {
  const proto = FLUIDSIM45_PROTOTYPES[meta.type];
  if (!proto) {
    throw new Error(`Missing FluidSIM 4.5 prototype for catalog type "${meta.type}".`);
  }
  const ports: PortDefinition[] = proto.gates
    .filter((g): g is typeof g & { portName: string } => Boolean(g.portName))
    .map((g) => ({
      name: g.portName,
      domain: g.domain,
      role: g.role,
      required: g.required,
      offset: { x: g.offsetMm.x, y: g.offsetMm.y },
      normal: g.normal,
    }));

  return {
    type: meta.type,
    fluidsim45Id: proto.fluidsimClass,
    fluidsim45IdVerified: proto.verified,
    displayName: meta.displayName,
    category: meta.category,
    domain: meta.domain,
    description: meta.description,
    keywords: meta.keywords,
    ports,
    parameters: meta.parameters,
    defaultSize: { width: proto.sizeMm.width, height: proto.sizeMm.height },
    layoutLayer: meta.layoutLayer,
    supportsDistanceRule: meta.supportsDistanceRule,
    supportsActuationConfig: meta.supportsActuationConfig,
  };
});

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
        def.fluidsim45Id,
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
