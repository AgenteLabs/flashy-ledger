// Types for the vendored invariants/1 harness, so a TypeScript test can import it.
//
// `vendor-invariants.mjs` is a byte-identical copy of canon (spec-kit,
// `vendor-invariants.mjs`) and carries no declarations of its own. This file is
// this package's and is not part of the vendored copy; the drift test compares
// the .mjs only. The shapes are the harness's, not this package's: a system is
// whatever `setup` returns, an op's value is whatever the op resolved.

export const KIT: 'invariants/1';

export interface Rng {
  readonly seed: number;
  next(): number;
  int(n: number): number;
  pick<T>(xs: readonly T[]): T;
  bool(p?: number): boolean;
}
export function rng(seed?: number): Rng;

export interface Step {
  name: string;
  args: unknown;
}
export interface Applied extends Step {
  result?: unknown;
  error?: string;
}
export type Settled = { ok: true; value: unknown } | { ok: false; error: string };
export interface ScheduleFailure {
  schedule: string;
  pattern: string;
  results: Settled[];
  violations: string[];
}
/** A reason the system is wrong, or nothing. A string is one reason; an array is several. */
export type Violations = string | string[] | null | undefined | void;

export class InvariantViolation extends Error {
  constructor(message: string, details?: Record<string, unknown>);
  readonly name: 'InvariantViolation';
  seed?: number;
  run?: number;
  sequence?: Step[];
  violations?: string[];
  applied?: Applied[];
  failures?: ScheduleFailure[];
  schedules?: number;
}

export interface Command<S> {
  name: string;
  // Method syntax on purpose: a command written with a concrete `args` type is
  // assignable here, which is what lets each command name its own arguments.
  gen?(r: Rng, seq: Step[]): unknown;
  run(sys: S, args: never): unknown;
}
export interface PropertySpec<S> {
  setup: () => S | Promise<S>;
  commands: ReadonlyArray<Command<S>>;
  invariants: (sys: S, ctx: { applied: Applied[]; step: number }) => Violations | Promise<Violations>;
  tick?: (sys: S) => unknown;
  runs?: number;
  maxLen?: number;
  seed?: number;
}
export function property<S>(spec: PropertySpec<S>): Promise<{ kit: string; seed: number; runs: number; commands: number }>;

export function shrink(seq: Step[], fails: (seq: Step[]) => boolean | Promise<boolean>): Promise<Step[]>;

export interface Op<S> {
  name: string;
  run(sys: S): unknown;
}
export interface InterleaveContext {
  results: Settled[];
  schedule: string;
  a: string;
  b: string;
  pattern: string;
}
export interface InterleaveSpec<S> {
  setup: () => S | Promise<S>;
  ops: ReadonlyArray<Op<S>>;
  invariants: (sys: S, ctx: InterleaveContext) => Violations | Promise<Violations>;
  tick?: (sys: S) => unknown;
  pairs?: 'all' | 'distinct' | ReadonlyArray<readonly [string, string]>;
}
export function interleave<S>(spec: InterleaveSpec<S>): Promise<{ kit: string; pairs: number; schedules: number }>;

export function expectViolation(fn: () => unknown, opts?: { match?: RegExp }): Promise<InvariantViolation>;

export function checkInvariantsDoc(
  markdown: string,
  testSource: string,
): { valid: boolean; invariants: { id: string; name: string }[]; citations: string[]; problems: string[] };

export function cli(argv?: string[]): Promise<number>;
