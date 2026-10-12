function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing Git view element: ${id}`);
  return node;
}

const repository = element("repository");
const files = element("files");
const empty = element("empty");
const count = element("count");
const summary = element("summary");
const branch = element("branch");
const root = element("root");
const repositoryName = element("repository-name");
const tracking = element("tracking");
const error = element("error");
const tree = element("tree");
const list = element("list");
const refreshElement = element("refresh");
const filterElement = element("filter");
if (
  !(refreshElement instanceof HTMLButtonElement) ||
  !(filterElement instanceof HTMLInputElement)
)
  throw new Error("Expected Git view controls");
const refresh = refreshElement;
const filter = filterElement;

const groupNames: Readonly<Record<GitPaneGroup, string>> = {
  conflicts: "Merge conflicts",
  staged: "Staged changes",
  unstaged: "Changes",
  untracked: "Untracked files",
};
const groups: GitPaneGroup[] = ["conflicts", "staged", "unstaged", "untracked"];
const statusNames: Readonly<Record<string, string>> = {
  M: "Modified",
  T: "Type changed",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Unmerged",
};

function isGroup(value: unknown): value is GitPaneGroup {
  return (
    value === "conflicts" ||
    value === "staged" ||
    value === "unstaged" ||
    value === "untracked"
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFile(value: unknown): value is GitPaneFile {
  return (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    typeof value.status === "string" &&
    "path" in value &&
    typeof value.path === "string" &&
    (!("originalPath" in value) || typeof value.originalPath === "string") &&
    "groups" in value &&
    Array.isArray(value.groups) &&
    value.groups.length > 0 &&
    value.groups.every(isGroup)
  );
}

function isGitPaneData(value: GitPaneState): value is GitPaneData {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const counts = value.counts;
  return (
    typeof value.root === "string" &&
    typeof value.branch === "string" &&
    (value.upstream === null || typeof value.upstream === "string") &&
    isCount(value.ahead) &&
    isCount(value.behind) &&
    isCount(value.total) &&
    typeof value.detached === "boolean" &&
    typeof value.unborn === "boolean" &&
    typeof value.upstreamGone === "boolean" &&
    (value.error === undefined || typeof value.error === "string") &&
    counts !== null &&
    typeof counts === "object" &&
    !Array.isArray(counts) &&
    groups.every((group) => isCount(counts[group])) &&
    Array.isArray(value.files) &&
    value.files.every(isFile)
  );
}

function statusLabel(file: GitPaneFile, group: GitPaneGroup): string {
  if (group === "conflicts") return "Merge conflict";
  if (group === "untracked") return "Untracked";
  return (
    statusNames[file.status[group === "staged" ? 0 : 1] ?? ""] ?? "Changed"
  );
}

function statusCode(file: GitPaneFile, group: GitPaneGroup): string {
  if (group === "untracked") return "?";
  if (group === "conflicts") return "!";
  return file.status[group === "staged" ? 0 : 1] ?? "";
}

function trackingLabel(data: GitPaneData): string {
  if (data.detached) return "Changes will not update a branch";
  if (data.unborn) return "No commits yet";
  if (data.upstreamGone)
    return `${data.upstream ?? "Upstream"} · upstream removed`;
  if (!data.upstream) return "No upstream configured";
  const parts = [data.upstream];
  if (data.ahead) parts.push(`${data.ahead} ahead`);
  if (data.behind) parts.push(`${data.behind} behind`);
  if (!data.ahead && !data.behind) parts.push("Up to date");
  return parts.join(" · ");
}

let data: GitPaneData | undefined;
let previousFiles: string | undefined;
let layout: "tree" | "list" = "tree";
const disclosureState = new Map<string, boolean>();
let renderedKeys = new Set<string>();

function disclosure(
  key: string,
  className: string,
  open: boolean,
): HTMLDetailsElement {
  const details = document.createElement("details");
  details.id = key;
  details.className = className;
  details.open = disclosureState.get(key) ?? open;
  renderedKeys.add(key);
  details.addEventListener("toggle", () => {
    if (details.isConnected) disclosureState.set(key, details.open);
  });
  return details;
}

function text(className: string, value: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = value;
  return span;
}

function fileRow(file: GitPaneFile, group: GitPaneGroup): HTMLLIElement {
  const row = document.createElement("li");
  const details = disclosure(
    JSON.stringify([group, file.path, "file"]),
    "file",
    false,
  );
  const heading = document.createElement("summary");
  const separator = file.path.lastIndexOf("/");
  const path = text("path", "");
  path.append(text("name", file.path.slice(separator + 1)));
  if (layout === "list" && separator >= 0)
    path.append(text("directory", file.path.slice(0, separator)));
  const label = statusLabel(file, group);
  const status = text("status", statusCode(file, group));
  status.title = label;
  status.dataset.kind = group;
  heading.title = `${file.path} — ${label}`;
  heading.append(path, status);
  const detail = document.createElement("div");
  detail.className = "file-detail";
  detail.append(text("detail-status", label), text("detail-path", file.path));
  if (file.originalPath !== undefined)
    detail.append(text("detail-path", `From: ${file.originalPath}`));
  if (file.groups.includes("staged") && file.groups.includes("unstaged"))
    detail.append(text("detail-note", "Also has changes in the other group"));
  details.append(heading, detail);
  row.append(details);
  return row;
}

interface Directory {
  directories: Map<string, Directory>;
  files: GitPaneFile[];
}

function directory(): Directory {
  return { directories: new Map(), files: [] };
}

function fileTree(
  entries: GitPaneFile[],
  group: GitPaneGroup,
): HTMLUListElement {
  const treeRoot = directory();
  for (const file of entries) {
    let parent = treeRoot;
    const parts = file.path.split("/").slice(0, -1);
    for (const part of parts) {
      let child = parent.directories.get(part);
      if (!child) {
        child = directory();
        parent.directories.set(part, child);
      }
      parent = child;
    }
    parent.files.push(file);
  }
  function rows(node: Directory, prefix: string): HTMLUListElement {
    const result = document.createElement("ul");
    for (const [name, child] of [...node.directories].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      let label = name;
      let compacted = child;
      while (!compacted.files.length && compacted.directories.size === 1) {
        const next = compacted.directories.entries().next().value;
        if (!next) break;
        label += "/" + next[0];
        compacted = next[1];
      }
      const path = prefix + label + "/";
      const row = document.createElement("li");
      const details = disclosure(
        JSON.stringify([group, path, "directory"]),
        "folder",
        true,
      );
      const heading = document.createElement("summary");
      heading.title = path;
      heading.append(text("folder-name", label));
      details.append(heading, rows(compacted, path));
      row.append(details);
      result.append(row);
    }
    for (const file of node.files) result.append(fileRow(file, group));
    return result;
  }
  return rows(treeRoot, "");
}

function renderFiles(): void {
  if (!data) return;
  const focusedKey = files.contains(document.activeElement)
    ? document.activeElement?.parentElement?.id
    : undefined;
  const query = filter.value.trim().toLocaleLowerCase();
  const matching = data.files
    .filter(
      (file) =>
        !query ||
        file.path.toLocaleLowerCase().includes(query) ||
        file.originalPath?.toLocaleLowerCase().includes(query),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  const fragment = document.createDocumentFragment();
  renderedKeys = new Set();
  for (const group of groups) {
    const entries = matching.filter((file) => file.groups.includes(group));
    if (!entries.length && (query || data.counts[group] === 0)) continue;
    const section = disclosure(group, "change-group", true);
    const heading = document.createElement("summary");
    heading.append(
      text("group-name", groupNames[group]),
      text("group-count", String(query ? entries.length : data.counts[group])),
    );
    section.append(heading);
    if (layout === "tree") section.append(fileTree(entries, group));
    else {
      const rows = document.createElement("ul");
      for (const file of entries) rows.append(fileRow(file, group));
      section.append(rows);
    }
    fragment.append(section);
  }
  files.replaceChildren(fragment);
  if (focusedKey) {
    const heading = document.getElementById(focusedKey)?.firstElementChild;
    if (heading instanceof HTMLElement) heading.focus({ preventScroll: true });
  }
  for (const key of disclosureState.keys())
    if (!renderedKeys.has(key)) disclosureState.delete(key);
  empty.hidden =
    data.error !== undefined ||
    (data.total !== 0 && (!query || matching.length > 0));
  empty.textContent =
    data.total === 0 ? "Working tree clean" : "No matching changed files";
  const notes: string[] = [];
  if (query)
    notes.push(
      `${matching.length} matching file${matching.length === 1 ? "" : "s"}`,
    );
  if (data.total > data.files.length)
    notes.push(`Showing ${data.files.length} of ${data.total} changed files`);
  summary.textContent = notes.join(" · ");
  tree.setAttribute("aria-pressed", String(layout === "tree"));
  list.setAttribute("aria-pressed", String(layout === "list"));
}

function render(state: GitPaneState): void {
  const ready = isGitPaneData(state);
  repository.hidden = !ready;
  files.hidden = !ready || state.error !== undefined;
  refresh.disabled = !ready;
  filter.disabled = !ready || state.error !== undefined;
  error.hidden = !ready || state.error === undefined;
  count.textContent =
    ready && state.error === undefined
      ? `${state.total} changed file${state.total === 1 ? "" : "s"}`
      : "";
  if (!ready) {
    data = undefined;
    empty.hidden = true;
    summary.textContent = "";
    return;
  }
  if (data?.root !== state.root) {
    disclosureState.clear();
    filter.value = "";
    previousFiles = undefined;
  }
  data = state;
  repositoryName.textContent = state.root.split("/").pop() || state.root;
  branch.textContent = state.branch || "Branch unavailable";
  root.textContent = state.root;
  root.title = state.root;
  tracking.textContent = state.error === undefined ? trackingLabel(state) : "";
  error.textContent =
    state.error === undefined ? "" : `Git status unavailable. ${state.error}`;
  const serialized = JSON.stringify([
    state.files,
    state.counts,
    state.total,
    state.error,
  ]);
  if (serialized === previousFiles) return;
  previousFiles = serialized;
  renderFiles();
}

refresh.addEventListener("click", () =>
  window.ghostty.send({ action: "refresh" }),
);
filter.addEventListener("input", renderFiles);
tree.addEventListener("click", () => {
  layout = "tree";
  renderFiles();
});
list.addEventListener("click", () => {
  layout = "list";
  renderFiles();
});
window.ghostty.onState(({ data }) => render(data));
