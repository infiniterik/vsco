/** Shared stdin/stdout helpers for hook commands. */

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
  process.stdout.write(JSON.stringify(obj));
}
