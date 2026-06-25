import { resolve, sep } from "node:path";

import { reactDir } from "./debug.js";

/** The base directory reads/writes must stay inside: the workspace root. */
export function baseDir(): string {
  return process.cwd();
}

/**
 * Resolve `p` (relative to the base dir) and return the absolute path, but only if
 * it stays inside the base directory. Throws a refusal otherwise — this is the path
 * containment guard for the file tools. Blocks `..` traversal and absolute escapes.
 */
export function resolveWithinBase(p: string): string {
  const base = baseDir();
  const abs = resolve(base, p);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`Refused: '${p}' is outside the workspace base directory.`);
  }
  return abs;
}

/**
 * True if `abs` is inside the `.react-byok/` control directory. write_file refuses
 * these so the agent can't rewrite its own guardrail config (context.json) to
 * disable approval.
 */
export function isWithinControlDir(abs: string): boolean {
  const ctrl = reactDir();
  return abs === ctrl || abs.startsWith(ctrl + sep);
}
