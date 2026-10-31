/** Parsed JSON lines the lib writes on stdout while the returned array is in use; restored by `jest.restoreAllMocks()`. */
export function captureLogs(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line) as Record<string, unknown>);
    return true;
  }) as typeof process.stdout.write);
  return lines;
}
