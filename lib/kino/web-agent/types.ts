export type ConnectedSite = {
  id: string;
  name: string;
  startUrl: string;
  allowedOrigin: string;
  storageStatePath: string;
};

export type ResolvedConnectedSite = ConnectedSite & {
  storageStateAbsolutePath: string;
};

export type NavigationSiteSummary = {
  id: string;
  name: string;
};

export type NavigationFailureCode =
  | "INVALID_ARGUMENTS"
  | "NO_CONNECTION"
  | "SITE_REQUIRED"
  | "SITE_NOT_FOUND"
  | "INVALID_CONNECTION"
  | "SESSION_NOT_FOUND"
  | "AUTH_EXPIRED"
  | "UNEXPECTED_ORIGIN"
  | "NO_MATCH"
  | "AMBIGUOUS_MATCH"
  | "EXTERNAL_NAVIGATION_BLOCKED"
  | "UNSAFE_NAVIGATION_BLOCKED"
  | "NO_URL_CHANGE"
  | "PAGE_READ_ERROR"
  | "BROWSER_ERROR";

export type NavigationFailure = {
  success: false;
  code: NavigationFailureCode;
  message: string;
  requested?: string;
  site?: NavigationSiteSummary;
  availableNavigation?: string[];
  candidates?: string[];
};

export type NavigationSuccess = {
  success: true;
  site: NavigationSiteSummary;
  requested: string;
  matched: string;
  previousUrl: string;
  finalUrl: string;
  pageTitle: string;
  authentication: "ACTIVE";
  visibleNavigationLinks: number;
  browserReused: boolean;
};

export type NavigationResult = NavigationSuccess | NavigationFailure;

export type PageReadTable = {
  role: "table" | "grid";
  name?: string;
  headers: string[];
  rows: string[][];
  returnedRowValueCounts: Record<string, Record<string, number>>;
  visibleRowCount: number | null;
  rowsReturned: number;
  truncated: boolean;
};

export type PageReadList = {
  items: string[];
  visibleItemCount: number;
  returnedItemCount: number;
  truncated: boolean;
};

export type PageReadControl = {
  role: "textbox" | "combobox" | "checkbox" | "radio" | "searchbox";
  name: string;
};

export type PageReadFailure = {
  success: false;
  code: NavigationFailureCode;
  message: string;
  focus?: string;
  site?: NavigationSiteSummary;
  availableSites?: NavigationSiteSummary[];
};

export type PageReadSuccess = {
  success: true;
  site: NavigationSiteSummary;
  url: string;
  title: string;
  authentication: "ACTIVE";
  focus?: string;
  headings: string[];
  tables: PageReadTable[];
  lists: PageReadList[];
  links: Array<{ name: string }>;
  buttons: Array<{ name: string }>;
  controls: PageReadControl[];
  text: string[];
  truncated: boolean;
  truncatedSections: string[];
  browserReused: boolean;
};

export type PageReadResult = PageReadSuccess | PageReadFailure;
