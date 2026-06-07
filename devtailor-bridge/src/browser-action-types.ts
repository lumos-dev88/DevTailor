export type BrowserActionName =
  | 'take_visible_screenshot'
  | 'get_page_snapshot'
  | 'get_console_logs'
  | 'get_console_message'
  | 'get_element_targets'
  | 'save_element_target'
  | 'delete_element_target'
  | 'reload_page'
  | 'click_page'
  | 'type_text'
  | 'fill_text'
  | 'press_key'
  | 'clear_state'
  | 'wait_for_selector'
  | 'wait_for_text'
  | 'run_actions'
  | 'request_user_assistance'
  | 'run_js';

export interface BrowserActionEvent {
  type: 'browser_action';
  requestId: string;
  action: BrowserActionName;
  params: Record<string, unknown>;
}

export interface BrowserActionResult {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    detail?: unknown;
  };
}

export interface BrowserContextState {
  activeClientId: string | null;
  activeProjectId: string | null;
  activeSessionId: string | null;
  lastSeenAt: number;
}
