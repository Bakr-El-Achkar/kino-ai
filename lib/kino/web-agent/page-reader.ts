import type { Locator, Page } from "playwright";

import {
  BrowserSessionError,
  getBrowserSession,
} from "./browser-manager";
import { ConnectionError, getConnectedSite } from "./connections";
import {
  isAllowedOrigin,
  isAuthenticationRoute,
  safeUrlForLog,
  settleVisiblePage,
} from "./page-safety";
import type {
  NavigationSiteSummary,
  PageReadControl,
  PageReadFailure,
  PageReadList,
  PageReadResult,
  PageReadSuccess,
  PageReadTable,
  ResolvedConnectedSite,
} from "./types";

const MAX_FOCUS_LENGTH = 240;
const MAX_HEADINGS = 10;
const MAX_LINKS = 12;
const MAX_BUTTONS = 10;
const MAX_CONTROLS = 8;
const MAX_TABLES = 3;
const MAX_TABLE_SCAN = 10;
const MAX_TABLE_ROWS_TOTAL = 25;
const MAX_ROW_SCAN = 100;
const MAX_TABLE_COLUMNS = 12;
const MAX_CELL_CHARACTERS = 100;
const MAX_TABLE_CHARACTERS = 3_200;
const MAX_LISTS = 3;
const MAX_LIST_ITEMS = 25;
const MAX_LIST_CHARACTERS = 1_200;
const MAX_TEXT_BLOCKS = 12;
const MAX_TEXT_CHARACTERS = 1_200;
const MAX_RESULT_CHARACTERS = 6_500;
const FOCUS_STOP_WORDS = new Set([
  "about",
  "current",
  "from",
  "here",
  "information",
  "page",
  "that",
  "this",
  "visible",
  "what",
  "with",
]);
const FOCUS_EXPANSIONS: Record<string, string[]> = {
  booking: ["bookings", "reservation", "reservations", "customer", "status"],
  bookings: ["booking", "reservation", "reservations", "customer", "status"],
  count: ["counts", "row", "rows", "result", "results", "showing", "total"],
  revenue: ["amount", "income", "money", "paid", "payment", "sales", "total"],
  summary: ["overview", "totals", "total"],
};

export type ReadConnectedPageInput = {
  siteId?: string;
  focus?: string;
};

type TextBudget = {
  remaining: number;
  truncated: boolean;
};

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeVisibleText(value: string) {
  return normalize(value)
    .replace(
      /\b(?:authorization|bearer|access[_ -]?token|refresh[_ -]?token)\s*[:=]?\s*\S+/gi,
      "[REDACTED AUTH DATA]",
    )
    .replace(/\bpassword\s*[:=]\s*\S+/gi, "[REDACTED PASSWORD]");
}

function compactText(value: string, maximum: number) {
  const sanitized = sanitizeVisibleText(value);
  if (sanitized.length <= maximum) return { text: sanitized, truncated: false };
  return {
    text: `${sanitized.slice(0, Math.max(0, maximum - 3))}...`,
    truncated: true,
  };
}

function nameFromAriaSnapshot(snapshot: string) {
  const match = snapshot.match(
    /^\s*-\s+[a-z][\w-]*(?:\s+"((?:\\.|[^"\\])*)")?/im,
  );
  if (!match?.[1]) return "";

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replaceAll('\\"', '"');
  }
}

async function getAccessibleName(locator: Locator) {
  try {
    const snapshot = await locator.ariaSnapshot({ mode: "ai", depth: 0 });
    const name = nameFromAriaSnapshot(snapshot);
    if (name) return compactText(name, 120).text;
  } catch {
    // Fall through to accessibility-related labels without reading values.
  }

  const fallback =
    (await locator.getAttribute("aria-label")) ??
    (await locator.getAttribute("title")) ??
    (await locator.getAttribute("alt")) ??
    "";
  return compactText(fallback, 120).text;
}

async function getVisibleText(locator: Locator, maximum: number) {
  if (!(await locator.isVisible())) return null;
  const value = compactText(await locator.innerText(), maximum);
  return value.text ? value : null;
}

function focusTerms(focus?: string) {
  if (!focus) return [];
  const directTerms =
    focus
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((term) => term.length >= 3 && !FOCUS_STOP_WORDS.has(term)) ?? [];
  return [
    ...new Set(
      directTerms.flatMap((term) => [
        term,
        ...(term.endsWith("s") && term.length > 4 ? [term.slice(0, -1)] : []),
        ...(FOCUS_EXPANSIONS[term] ?? []),
      ]),
    ),
  ];
}

function relevanceScore(value: string, terms: string[]) {
  const normalized = value.toLowerCase();
  return terms.reduce(
    (score, term) => score + (normalized.includes(term) ? 1 : 0),
    0,
  );
}

function prioritize<T>(
  values: T[],
  terms: string[],
  getText: (value: T) => string,
) {
  if (terms.length === 0) return values;
  return values
    .map((value, index) => ({
      value,
      index,
      score: relevanceScore(getText(value), terms),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ value }) => value);
}

function prioritizeRelevant<T>(
  values: T[],
  terms: string[],
  getText: (value: T) => string,
  maximum: number,
  fallbackMaximum: number,
) {
  const prioritized = prioritize(values, terms, getText);
  if (terms.length === 0) return prioritized.slice(0, maximum);
  const relevant = prioritized.filter(
    (value) => relevanceScore(getText(value), terms) > 0,
  );
  return (relevant.length > 0 ? relevant : prioritized.slice(0, fallbackMaximum)).slice(
    0,
    maximum,
  );
}

function returnedRowValueCounts(headers: string[], rows: string[][]) {
  const result: Record<string, Record<string, number>> = {};
  const maximumDistinctValues = Math.min(10, Math.ceil(rows.length / 2));

  headers.forEach((header, columnIndex) => {
    const values = rows
      .map((row) => row[columnIndex])
      .filter((value): value is string => Boolean(value));
    if (values.length !== rows.length) return;

    const counts: Record<string, number> = {};
    for (const value of values) {
      counts[value] = (counts[value] ?? 0) + 1;
    }

    const distinctValues = Object.keys(counts).length;
    if (distinctValues > 0 && distinctValues <= maximumDistinctValues) {
      result[header] = counts;
    }
  });

  return result;
}

async function collectNamedRole(
  page: Page,
  role: "heading" | "link" | "button",
  maximum: number,
  terms: string[],
) {
  const locator = page.getByRole(role);
  const count = await locator.count();
  const names: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < count && names.length < maximum * 3; index += 1) {
    const candidate = locator.nth(index);
    try {
      if (!(await candidate.isVisible())) continue;
      const insideRecord = await candidate.evaluate((element) =>
        Boolean(element.closest('table, [role="table"], [role="grid"]')),
      );
      if (insideRecord) continue;

      const name = await getAccessibleName(candidate);
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    } catch {
      // Ignore elements that detach while the application settles.
    }
  }

  return prioritizeRelevant(names, terms, (name) => name, maximum, 2);
}

async function collectControls(page: Page, terms: string[]) {
  const roles: PageReadControl["role"][] = [
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
  ];
  const controls: PageReadControl[] = [];
  const seen = new Set<string>();

  for (const role of roles) {
    const locator = page.getByRole(role);
    const count = await locator.count();
    for (let index = 0; index < count && controls.length < MAX_CONTROLS * 2; index += 1) {
      const candidate = locator.nth(index);
      try {
        if (!(await candidate.isVisible())) continue;
        const inputType = await candidate.getAttribute("type");
        if (inputType?.toLowerCase() === "password") continue;

        const name = await getAccessibleName(candidate);
        const key = `${role}|${name.toLowerCase()}`;
        if (!name || seen.has(key)) continue;
        seen.add(key);
        controls.push({ role, name });
      } catch {
        // Ignore controls that detach while the application settles.
      }
    }
  }

  return prioritize(controls, terms, ({ name }) => name).slice(0, MAX_CONTROLS);
}

async function collectTables(page: Page, terms: string[]) {
  const candidates: PageReadTable[] = [];

  for (const role of ["table", "grid"] as const) {
    const locator = page.getByRole(role);
    const count = await locator.count();

    for (
      let index = 0;
      index < count && candidates.length < MAX_TABLE_SCAN;
      index += 1
    ) {
      const table = locator.nth(index);
      try {
        if (!(await table.isVisible())) continue;

        const accessibleName = await getAccessibleName(table);
        const caption = await getVisibleText(table.locator("caption").first(), 120);
        const associatedHeading = await table.evaluate((element) => {
          const container = element.closest("section, article, main") ?? element.parentElement;
          return container?.querySelector("h1, h2, h3, [role='heading']")?.textContent ?? "";
        });
        const name = compactText(
          accessibleName || caption?.text || associatedHeading,
          120,
        ).text;

        const headerLocator = table.locator("thead th, [role='columnheader']");
        const headerCount = await headerLocator.count();
        const headers: string[] = [];
        let tableTruncated = false;
        for (
          let headerIndex = 0;
          headerIndex < headerCount && headerIndex < MAX_TABLE_COLUMNS;
          headerIndex += 1
        ) {
          const header = await getVisibleText(
            headerLocator.nth(headerIndex),
            MAX_CELL_CHARACTERS,
          );
          if (!header) continue;
          headers.push(header.text);
          tableTruncated ||= header.truncated;
        }
        if (headerCount > MAX_TABLE_COLUMNS) tableTruncated = true;

        const rowLocator = table.getByRole("row");
        const rowCount = await rowLocator.count();
        const scannedRows = Math.min(rowCount, MAX_ROW_SCAN);
        const candidateRows: string[][] = [];
        let visibleRowCount = 0;

        for (let rowIndex = 0; rowIndex < scannedRows; rowIndex += 1) {
          const row = rowLocator.nth(rowIndex);
          if (!(await row.isVisible())) continue;

          const cellLocator = row.locator(
            "td, [role='cell'], [role='gridcell'], th[scope='row']",
          );
          const cellCount = await cellLocator.count();
          if (cellCount === 0) continue;
          visibleRowCount += 1;

          const cells: string[] = [];
          for (
            let cellIndex = 0;
            cellIndex < cellCount && cellIndex < MAX_TABLE_COLUMNS;
            cellIndex += 1
          ) {
            const cell = await getVisibleText(
              cellLocator.nth(cellIndex),
              MAX_CELL_CHARACTERS,
            );
            if (!cell) continue;
            cells.push(cell.text);
            tableTruncated ||= cell.truncated;
          }
          if (cellCount > MAX_TABLE_COLUMNS) tableTruncated = true;
          if (cells.length > 0) candidateRows.push(cells);
        }

        if (rowCount > MAX_ROW_SCAN) tableTruncated = true;
        const prioritizedRows = prioritize(
          candidateRows,
          terms,
          (row) => row.join(" "),
        );
        const rows = prioritizedRows.slice(0, MAX_TABLE_ROWS_TOTAL);
        const reliableVisibleRowCount =
          rowCount <= MAX_ROW_SCAN ? visibleRowCount : null;
        if (
          reliableVisibleRowCount === null ||
          reliableVisibleRowCount > rows.length ||
          prioritizedRows.length > rows.length
        ) {
          tableTruncated = true;
        }
        candidates.push({
          role,
          name: name || undefined,
          headers,
          rows,
          returnedRowValueCounts: returnedRowValueCounts(headers, rows),
          visibleRowCount: reliableVisibleRowCount,
          rowsReturned: rows.length,
          truncated: tableTruncated,
        });
      } catch {
        // Ignore a table that detaches while the application settles.
      }
    }
  }

  const tables = prioritizeRelevant(
    candidates,
    terms,
    (table) => [table.name, ...table.headers, ...table.rows.flat()].join(" "),
    MAX_TABLES,
    MAX_TABLES,
  );
  let rowsRemaining = MAX_TABLE_ROWS_TOTAL;
  let charactersRemaining = MAX_TABLE_CHARACTERS;
  let truncated = candidates.length > tables.length;

  for (const table of tables) {
    const keptRows: string[][] = [];
    for (const row of table.rows) {
      const rowCharacters = row.reduce((total, cell) => total + cell.length, 0);
      if (rowsRemaining === 0 || charactersRemaining < rowCharacters) {
        table.truncated = true;
        truncated = true;
        break;
      }
      rowsRemaining -= 1;
      charactersRemaining -= rowCharacters;
      keptRows.push(row);
    }
    if (keptRows.length < table.rows.length) table.truncated = true;
    table.rows = keptRows;
    table.rowsReturned = keptRows.length;
    table.returnedRowValueCounts = returnedRowValueCounts(
      table.headers,
      keptRows,
    );
    truncated ||= table.truncated;
  }

  return { tables, truncated };
}

async function collectLists(page: Page, terms: string[]) {
  const lists: PageReadList[] = [];
  const budget: TextBudget = {
    remaining: MAX_LIST_CHARACTERS,
    truncated: false,
  };
  const locator = page.getByRole("list");
  const count = await locator.count();

  for (let index = 0; index < count && lists.length < MAX_LISTS; index += 1) {
    const list = locator.nth(index);
    try {
      if (!(await list.isVisible())) continue;
      const excluded = await list.evaluate((element) =>
        Boolean(
          element.closest(
            'nav, [role="navigation"], table, [role="table"], [role="grid"]',
          ),
        ),
      );
      if (excluded) continue;

      const itemLocator = list.getByRole("listitem");
      const itemCount = await itemLocator.count();
      const candidates: string[] = [];
      let visibleItemCount = 0;

      for (
        let itemIndex = 0;
        itemIndex < itemCount && itemIndex < MAX_ROW_SCAN;
        itemIndex += 1
      ) {
        const item = await getVisibleText(itemLocator.nth(itemIndex), 180);
        if (!item) continue;
        visibleItemCount += 1;
        candidates.push(item.text);
        budget.truncated ||= item.truncated;
      }

      const items: string[] = [];
      for (const item of prioritize(candidates, terms, (value) => value)) {
        if (items.length >= MAX_LIST_ITEMS || budget.remaining < item.length) {
          budget.truncated = true;
          break;
        }
        budget.remaining -= item.length;
        items.push(item);
      }

      const truncated =
        itemCount > MAX_ROW_SCAN ||
        visibleItemCount > items.length ||
        budget.truncated;
      if (items.length > 0) {
        lists.push({
          items,
          visibleItemCount,
          returnedItemCount: items.length,
          truncated,
        });
      }
    } catch {
      // Ignore a list that detaches while the application settles.
    }
  }

  return { lists, truncated: budget.truncated };
}

async function collectTextBlocks(
  page: Page,
  terms: string[],
  duplicateNames: Set<string>,
) {
  const locator = page.locator(
    "main p, main article, main [role='status'], main [role='alert'], main section > header",
  );
  const count = await locator.count();
  const candidates: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (let index = 0; index < count && index < MAX_ROW_SCAN; index += 1) {
    const block = locator.nth(index);
    try {
      const excluded = await block.evaluate((element) =>
        Boolean(
          element.closest(
            'nav, [role="navigation"], table, [role="table"], [role="grid"], [role="list"]',
          ),
        ),
      );
      if (excluded) continue;

      const text = await getVisibleText(block, 220);
      if (!text) continue;
      truncated ||= text.truncated;

      const key = text.text.toLowerCase();
      if (seen.has(key) || duplicateNames.has(key)) continue;
      seen.add(key);
      candidates.push(text.text);
    } catch {
      // Ignore text blocks that detach while the application settles.
    }
  }

  const text: string[] = [];
  let remaining = MAX_TEXT_CHARACTERS;
  for (const candidate of prioritizeRelevant(
    candidates,
    terms,
    (value) => value,
    MAX_TEXT_BLOCKS,
    4,
  )) {
    if (text.length >= MAX_TEXT_BLOCKS || remaining < candidate.length) {
      truncated = true;
      break;
    }
    remaining -= candidate.length;
    text.push(candidate);
  }
  if (count > MAX_ROW_SCAN) truncated = true;
  return { text, truncated };
}

function enforceResultLimit(result: PageReadSuccess) {
  const currentLength = () => JSON.stringify(result).length;
  const markTruncated = () => {
    result.truncated = true;
  };

  while (currentLength() > MAX_RESULT_CHARACTERS) {
    if (result.text.length > 0) {
      result.text.pop();
      if (!result.truncatedSections.includes("text")) {
        result.truncatedSections.push("text");
      }
      markTruncated();
      continue;
    }
    if (result.links.length > 4) {
      result.links.pop();
      markTruncated();
      continue;
    }
    if (result.buttons.length > 4) {
      result.buttons.pop();
      markTruncated();
      continue;
    }
    const list = result.lists.find((candidate) => candidate.items.length > 3);
    if (list) {
      list.items.pop();
      list.returnedItemCount = list.items.length;
      list.truncated = true;
      if (!result.truncatedSections.includes("lists")) {
        result.truncatedSections.push("lists");
      }
      markTruncated();
      continue;
    }
    const table = result.tables.find((candidate) => candidate.rows.length > 3);
    if (table) {
      table.rows.pop();
      table.rowsReturned = table.rows.length;
      table.returnedRowValueCounts = returnedRowValueCounts(
        table.headers,
        table.rows,
      );
      table.truncated = true;
      if (!result.truncatedSections.includes("tables")) {
        result.truncatedSections.push("tables");
      }
      markTruncated();
      continue;
    }
    break;
  }
}

function siteSummary(site: ResolvedConnectedSite): NavigationSiteSummary {
  return { id: site.id, name: site.name };
}

function failure(result: Omit<PageReadFailure, "success">): PageReadFailure {
  return { success: false, ...result };
}

export async function readConnectedPage({
  siteId,
  focus,
}: ReadConnectedPageInput = {}): Promise<PageReadResult> {
  const normalizedFocus = focus ? normalize(focus) : undefined;
  if (normalizedFocus && normalizedFocus.length > MAX_FOCUS_LENGTH) {
    return failure({
      code: "INVALID_ARGUMENTS",
      message: "The page-reading focus must be concise.",
    });
  }

  let site: ResolvedConnectedSite;
  try {
    site = await getConnectedSite(siteId);
  } catch (error) {
    if (error instanceof ConnectionError) {
      return failure({
        code: error.code,
        message: error.message,
        focus: normalizedFocus,
        availableSites: error.availableSites,
      });
    }
    throw error;
  }

  const summary = siteSummary(site);

  try {
    const session = await getBrowserSession(site);
    const { page } = session;
    console.log(
      `Web Agent: ${session.reused ? "Reusing" : "Opened"} visible browser session for ${site.name}.`,
    );
    await settleVisiblePage(page);

    const currentUrl = page.url();
    if (isAuthenticationRoute(currentUrl)) {
      return failure({
        code: "AUTH_EXPIRED",
        message: "The saved website session has expired. Reconnect the website.",
        focus: normalizedFocus,
        site: summary,
      });
    }
    if (!isAllowedOrigin(currentUrl, site.allowedOrigin)) {
      return failure({
        code: "UNEXPECTED_ORIGIN",
        message: "The connected browser is not on its allowed website origin.",
        focus: normalizedFocus,
        site: summary,
      });
    }

    console.log(`Web Agent: Reading current page: ${safeUrlForLog(currentUrl)}`);
    const terms = focusTerms(normalizedFocus);
    const focusRequestsNavigation = terms.some((term) =>
      ["link", "menu", "navigate", "navigation", "section"].includes(term),
    );
    const focusRequestsControls = terms.some((term) =>
      ["button", "control", "filter", "form", "input", "search"].includes(term),
    );
    const [
      headings,
      linkNames,
      buttonNames,
      controls,
      tableResult,
      listResult,
    ] = await Promise.all([
      collectNamedRole(page, "heading", MAX_HEADINGS, terms),
      focus && !focusRequestsNavigation
        ? Promise.resolve([])
        : collectNamedRole(page, "link", focus ? MAX_LINKS : 6, terms),
      focus && !focusRequestsControls
        ? Promise.resolve([])
        : collectNamedRole(page, "button", focus ? MAX_BUTTONS : 6, terms),
      focus && !focusRequestsControls
        ? Promise.resolve([])
        : collectControls(page, terms),
      collectTables(page, terms),
      collectLists(page, terms),
    ]);
    const { tables, truncated: tablesTruncated } = tableResult;
    const { lists, truncated: listsTruncated } = listResult;

    const duplicateNames = new Set(
      [...headings, ...linkNames, ...buttonNames].map((value) =>
        value.toLowerCase(),
      ),
    );
    const { text, truncated: textTruncated } = await collectTextBlocks(
      page,
      terms,
      duplicateNames,
    );
    console.log(`Web Agent: ${tables.length} table/grid structure(s) discovered.`);

    const truncatedSections = [
      ...(tablesTruncated ? ["tables"] : []),
      ...(listsTruncated ? ["lists"] : []),
      ...(textTruncated ? ["text"] : []),
    ];

    const result: PageReadSuccess = {
      success: true,
      site: summary,
      url: safeUrlForLog(currentUrl),
      title: await page.title(),
      authentication: "ACTIVE",
      focus: normalizedFocus,
      headings,
      tables,
      lists,
      links: linkNames.map((name) => ({ name })),
      buttons: buttonNames.map((name) => ({ name })),
      controls,
      text,
      truncated: truncatedSections.length > 0,
      truncatedSections,
      browserReused: session.reused,
    };
    enforceResultLimit(result);

    console.log(
      `Web Agent: Page read completed (${JSON.stringify(result).length} characters, ` +
        `${tables.length} table(s), ${tables.reduce((total, table) => total + table.rowsReturned, 0)} row(s) returned, ` +
        `truncated: ${result.truncated}).`,
    );
    return result;
  } catch (error) {
    if (error instanceof BrowserSessionError) {
      return failure({
        code: error.code,
        message: error.message,
        focus: normalizedFocus,
        site: summary,
      });
    }

    console.error(
      "Web Agent page read error:",
      error instanceof Error ? error.message : "Unknown page-reading error.",
    );
    return failure({
      code: "PAGE_READ_ERROR",
      message: "The current connected webpage could not be read.",
      focus: normalizedFocus,
      site: summary,
    });
  }
}
