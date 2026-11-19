/**
 * Structured error contract for autonomous agent self-correction loops.
 */

export type FailureCategory =
  | 'InvalidTopology'
  | 'PneumaticRuleViolation'
  | 'ElectricalRuleViolation'
  | 'ParseError'
  | 'UnsupportedFormatVersion'
  | 'AccessDenied'
  | 'PostconditionFailed'
  | 'PayloadBudgetExceeded';

export interface EngineeringErrorPayload {
  category: FailureCategory;
  code: string;
  message: string;
  offendingIds: string[];
  suggestedFix: string;
  tick?: number;
  timeMs?: number;
  details?: Record<string, unknown>;
}

export class EngineeringError extends Error {
  public readonly category: FailureCategory;
  public readonly code: string;
  public readonly offendingIds: string[];
  public readonly suggestedFix: string;
  public readonly tick?: number;
  public readonly timeMs?: number;
  public readonly details?: Record<string, unknown>;

  constructor(payload: EngineeringErrorPayload) {
    super(payload.message);
    this.name = 'EngineeringError';
    this.category = payload.category;
    this.code = payload.code;
    this.offendingIds = payload.offendingIds;
    this.suggestedFix = payload.suggestedFix;
    this.tick = payload.tick;
    this.timeMs = payload.timeMs;
    this.details = payload.details;
  }

  public toPayload(): EngineeringErrorPayload {
    const out: EngineeringErrorPayload = {
      category: this.category,
      code: this.code,
      message: this.message,
      offendingIds: this.offendingIds,
      suggestedFix: this.suggestedFix,
    };
    if (this.tick !== undefined) out.tick = this.tick;
    if (this.timeMs !== undefined) out.timeMs = this.timeMs;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export interface ToolSuccess<T> {
  ok: true;
  data: T;
}

export interface ToolFailure {
  ok: false;
  error: EngineeringErrorPayload;
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

export function okResult<T>(data: T): ToolSuccess<T> {
  return { ok: true, data };
}

export function errResult(err: unknown): ToolFailure {
  if (err instanceof EngineeringError) {
    return { ok: false, error: err.toPayload() };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: {
      category: 'InvalidTopology',
      code: 'INTERNAL_ERROR',
      message,
      offendingIds: [],
      suggestedFix: 'Inspect tool arguments and retry with valid parameters.',
    },
  };
}
