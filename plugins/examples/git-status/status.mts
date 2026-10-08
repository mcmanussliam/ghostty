import type { GitFile, GitStatus } from "./types.mjs";

export function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

export function parseStatus(output: string): GitStatus {
  const records = output.split("\0");
  const header = records.shift() ?? "";
  const branch = truncate(header.replace(/^## /, ""), 256);
  const files: GitFile[] = [];
  let fileBytes = 0;
  let total = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    total++;
    if (files.length < 50 && fileBytes < 8 * 1024) {
      const file = { status, path: truncate(record.slice(3), 200) };
      const size = Buffer.byteLength(JSON.stringify(file)) + 1;
      // Leave room for the root and branch, including JSON escaping of control characters.
      if (fileBytes + size <= 8 * 1024) {
        files.push(file);
        fileBytes += size;
      }
    }
    // In -z mode rename/copy entries include the original path as an extra record.
    if (/[RC]/.test(status)) index++;
  }
  return { branch, files, total };
}
