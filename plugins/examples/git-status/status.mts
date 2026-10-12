import type { GitFile, GitGroup, GitStatus } from "./types.mjs";

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

function groupsFor(status: string): GitGroup[] {
  if (/^(DD|AU|UD|UA|DU|AA|UU)$/.test(status)) return ["conflicts"];
  if (status === "??") return ["untracked"];
  const groups: GitGroup[] = [];
  if (/[MTADRC]/.test(status[0] ?? "")) groups.push("staged");
  if (/[MTADRC]/.test(status[1] ?? "")) groups.push("unstaged");
  return groups;
}

function parseBranch(
  header: string,
): Omit<GitStatus, "files" | "total" | "counts"> {
  const value = header.replace(/^## /, "");
  const unborn = /^(No commits yet on |Initial commit on )/.test(value);
  const detached = value.startsWith("HEAD (");
  const tracking = value.match(/ \[(.+)\]$/)?.[1] ?? "";
  const ref = value
    .replace(/ \[.+\]$/, "")
    .replace(/^(No commits yet on |Initial commit on )/, "");
  const [branch = "", upstream] = ref.split("...");
  return {
    branch: truncate(detached ? "Detached HEAD" : branch, 256),
    upstream: upstream ? truncate(upstream, 256) : null,
    ahead: Number(tracking.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(tracking.match(/behind (\d+)/)?.[1] ?? 0),
    detached,
    unborn,
    upstreamGone: tracking === "gone",
  };
}

export function parseStatus(output: string): GitStatus {
  const records = output.split("\0");
  const header = records.shift() ?? "";
  const counts = { conflicts: 0, staged: 0, unstaged: 0, untracked: 0 };
  const files: GitFile[] = [];
  let fileBytes = 0;
  let total = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const groups = groupsFor(status);
    // In -z mode rename/copy entries carry the original path in the next record.
    const originalPath = /[RC]/.test(status) ? records[++index] : undefined;
    if (!groups.length) continue;
    total++;
    for (const group of groups) counts[group]++;
    if (files.length < 200 && fileBytes < 6 * 1024) {
      const file: GitFile = { status, path: record.slice(3), groups };
      if (originalPath !== undefined) file.originalPath = originalPath;
      const size = Buffer.byteLength(JSON.stringify(file)) + 1;
      // Leave room for the root and branch, including JSON escaping of control characters.
      if (fileBytes + size <= 6 * 1024) {
        files.push(file);
        fileBytes += size;
      }
    }
  }
  return { ...parseBranch(header), counts, files, total };
}
