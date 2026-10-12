import type { JSONValue, PaneBridge } from "../../sdk/dist/index.mjs";
import type { GitData, GitFile, GitGroup } from "./types.mjs";

declare global {
  interface Window {
    ghostty: PaneBridge;
  }
  type GitPaneState = JSONValue;
  type GitPaneData = GitData;
  type GitPaneFile = GitFile;
  type GitPaneGroup = GitGroup;
}
