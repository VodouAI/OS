// Types mirroring Swift Models.swift

export interface AXElement {
  id: number;
  role: string;
  title: string | null;
  value: string | null;
  position: { x: number; y: number } | null;
  size: { width: number; height: number } | null;
  enabled: boolean;
  focused: boolean;
  children: number[];
  actions: string[];
}

export interface DiffResult {
  added: { id: number; role: string; title: string | null }[];
  removed: { id: number; role: string; title: string | null }[];
  modified: { id: number; role: string; field: string; old: string | null; new: string | null }[];
}

export interface TraversalResponse {
  ok: boolean;
  app: string;
  pid: number;
  timestamp: string;
  element_count: number;
  truncated: boolean;
  tree: AXElement[];
  tmp_file: string | null;
}

export interface ActionResponse extends TraversalResponse {
  action: string;
  diff: DiffResult | null;
}

export interface ScreenshotResponse {
  ok: boolean;
  app: string | null;
  pid: number | null;
  screenshot_path: string;
  size_bytes: number;
}

export interface ClipboardResponse {
  ok: boolean;
  content: string | null;
  written: boolean | null;
}

export interface WindowInfo {
  app: string;
  title: string;
  pid: number;
  bounds: { x: number; y: number; width: number; height: number };
  layer: number;
  on_screen: boolean;
}

export interface WindowsResponse {
  ok: boolean;
  windows: WindowInfo[] | null;
  focused: string | null;
  action_result: string | null;
}

export interface PermissionResponse {
  ok: boolean;
  accessibility_granted: boolean;
}

export interface ErrorResponse {
  ok: false;
  error: string;
  message: string;
  app: string | null;
}

export type VodouAxResponse =
  | TraversalResponse
  | ActionResponse
  | ScreenshotResponse
  | ClipboardResponse
  | WindowsResponse
  | PermissionResponse
  | ErrorResponse;
