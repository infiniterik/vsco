/** Shared stdin/stdout helpers for hook commands. */

// A hook's stdout MUST contain only the JSON result. Bundled dependencies (e.g.
// pdf.js) can write warnings to stdout, which would corrupt that protocol.
let realStdoutWrite: typeof process.stdout.write = process.stdout.write.bind(process.stdout);

/**
 * Route process.stdout (and therefore console.log / library chatter) to stderr so
 * only writeOutput() reaches the real stdout. Called by each hook's main(); NOT run
 * at import, so importing these modules in tests doesn't hijack stdout.
 */
export function protectStdout(): void {
  realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr.write as any)(chunk, ...rest)) as typeof process.stdout.write;
}

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

export function parseStdin<T>(raw: string): Partial<T> {
  try {
    return JSON.parse(raw) as Partial<T>;
  } catch {
    return {} as Partial<T>;
  }
}

export function writeOutput(obj: unknown): void {
  realStdoutWrite(JSON.stringify(obj));
}
