export type BrowserStatus =
  | "OPENED"
  | "OBSERVED"
  | "SCREENSHOT_READY"
  | "AUTH_REQUIRED"
  | "AUTH_SUCCESS"
  | "AUTH_FAILED"
  | "MFA_REQUIRED"
  | "CAPTCHA_REQUIRED"
  | "ACTION_COMPLETED"
  | "ACTION_UNVERIFIED"
  | "ACTION_NEEDS_CONFIRMATION"
  | "ACTION_CANCELLED"
  | "ELEMENT_NOT_FOUND"
  | "ELEMENT_NOT_ACTIONABLE"
  | "PAGE_CHANGED"
  | "SESSION_EXPIRED"
  | "SESSION_CLOSED"
  | "WORKER_UNAVAILABLE"
  | "URL_BLOCKED"
  | "INVALID_REQUEST"
  | "ACTION_FAILED"
  | "CONFIRMATION_REJECTED";

export type SemanticElementRole =
  | "link"
  | "button"
  | "textbox"
  | "searchbox"
  | "combobox"
  | "checkbox"
  | "radio"
  | "switch"
  | "tab";

export type SemanticElement = {
  id: string;
  role: SemanticElementRole;
  name: string;
  label?: string;
  text?: string;
  placeholder?: string;
  inputType?: string;
  checked?: boolean;
  disabled: boolean;
  selectedOption?: string;
  options?: string[];
  href?: string;
};

export type AuthenticationChallenge = {
  usernameField: boolean;
  passwordField: boolean;
  usernameLabel?: string;
  passwordLabel?: string;
};

export type BrowserObservation = {
  status: "OBSERVED" | "AUTH_REQUIRED" | "MFA_REQUIRED" | "CAPTCHA_REQUIRED";
  url: string;
  title: string;
  visibleText: string[];
  elements: SemanticElement[];
  truncated: boolean;
  authentication?: AuthenticationChallenge;
  learnedNavigation: string[];
};

export type BrowserActionKind =
  | "click"
  | "fill"
  | "select"
  | "check"
  | "uncheck"
  | "back"
  | "reload"
  | "scroll";

export type PendingBrowserAction = {
  id: string;
  elementId: string;
  action: BrowserActionKind;
  summary: string;
  risk: "write" | "critical";
  requiredConfirmationPhrase?: string;
  expiresAt: string;
};

export type BrowserOpenResult = {
  success: boolean;
  status: BrowserStatus;
  message: string;
  observation?: BrowserObservation;
};

export type BrowserActionResult = BrowserOpenResult & {
  action?: BrowserActionKind;
  elementId?: string;
  effectVerified?: boolean;
  pendingAction?: PendingBrowserAction;
};

export type AuthenticationResult = BrowserOpenResult & {
  authenticated: boolean;
};

export type BrowserSessionState = {
  success: boolean;
  status: BrowserStatus;
  message: string;
  observation?: BrowserObservation;
  pendingAction?: PendingBrowserAction;
};

export type BrowserViewState = {
  success: boolean;
  status: BrowserStatus;
  message: string;
  active: boolean;
  url?: string;
  title?: string;
  pageStatus?: BrowserObservation["status"];
  authentication?: AuthenticationChallenge;
  updatedAt?: string;
};

export type BrowserScreenshot = {
  success: true;
  status: "SCREENSHOT_READY";
  contentType: "image/jpeg";
  bytes: ArrayBuffer;
};

export type BrowserGoalResult = {
  status: "GOAL_COMPLETED" | "MAX_STEPS_REACHED" | "LOOP_DETECTED" | "USER_INPUT_REQUIRED";
  steps: number;
  message: string;
};

export type WorkerErrorResult = {
  success: false;
  status: BrowserStatus;
  message: string;
};
