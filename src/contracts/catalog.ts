/**
 * Verified ISO 1219 & FluidSIM Pneumatics 4.5 component catalog contracts.
 */

export type Domain = 'pneumatic' | 'electrical' | 'hybrid';

export type PortDomain = 'pneumatic' | 'electrical';

export type PortNormal = 'N' | 'S' | 'E' | 'W';

export type PortRole =
  | 'supply'
  | 'working'
  | 'exhaust'
  | 'pilot'
  | 'vacuum'
  | 'power_pos'
  | 'power_neg'
  | 'coil_in'
  | 'coil_out'
  | 'contact_in'
  | 'contact_out'
  | 'contact_com'
  | 'contact_no'
  | 'contact_nc'
  | 'signal';

export type ComponentCategory =
  | 'air_supply'
  | 'actuator'
  | 'directional_valve'
  | 'flow_pressure_logic'
  | 'vacuum'
  | 'measuring'
  | 'electrical_power'
  | 'electrical_switch'
  | 'electrical_relay'
  | 'electrical_actuator';

export type ValveActuationType =
  | 'none'
  | 'pushbutton'
  | 'detent'
  | 'roller'
  | 'idle_return_roller'
  | 'pneumatic_pilot'
  | 'pneumatic_spring'
  | 'solenoid'
  | 'spring';

export interface PortDefinition {
  /** ISO 1219 or IEC port label (e.g., "1", "2", "3", "4", "5", "12", "14", "1v", "P1", "P2", "A1", "A2"). */
  name: string;
  domain: PortDomain;
  role: PortRole;
  required: boolean;
  /** Default relative port anchor offset (mm in FluidSIM grid coordinates) derived from the canonical prototype. */
  offset: { x: number; y: number };
  /** Outward port exit normal at canonical rot=0, mirror="none" orientation. */
  normal?: PortNormal;
}

export interface ParameterSpec {
  key: string;
  type: 'number' | 'string' | 'boolean' | 'enum';
  defaultValue: number | string | boolean;
  description: string;
  unit?: string;
  min?: number;
  max?: number;
  enumValues?: readonly string[];
}

export interface CatalogComponentDef {
  /** Canonical semantic type name used by agents. */
  type: string;
  /** FluidSIM 4.5 internal symbol/object identifier from official sym/ prototypes. */
  fluidsim45Id: string;
  /** True when empirically verified against real FluidSIM 4.5 .ct files or sym/ prototypes. */
  fluidsim45IdVerified: boolean;
  displayName: string;
  category: ComponentCategory;
  domain: Domain;
  description: string;
  keywords: readonly string[];
  ports: readonly PortDefinition[];
  parameters: readonly ParameterSpec[];
  /** Default bounding size (mm) derived directly from the FluidSIM 4.5 prototype registry. */
  defaultSize: { width: number; height: number };
  /** Preferred vertical ISO 1219 layout layer (0=top actuators ... 4=bottom air supply, 10+=ladder). */
  layoutLayer: number;
  /** Supports distance rule markers (linear cylinders, rodless cylinders, swivel drives). */
  supportsDistanceRule?: boolean;
  /** Supports pilot/solenoid label bindings on left/right sides (directional valves). */
  supportsActuationConfig?: boolean;
}
