// Captures the JSON lines of a logger.
export function captureLogs() {
  const lines = [];
  return { lines, write: (line) => lines.push(JSON.parse(line)) };
}
