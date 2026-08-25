import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  NavigationFailureCode,
  ResolvedConnectedSite,
} from "./types";

const CONNECTIONS_DIRECTORY = ".kino/connections";
const SESSIONS_DIRECTORY = ".kino/sessions";
const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

type UnknownRecord = Record<string, unknown>;

export class ConnectionError extends Error {
  constructor(
    readonly code: NavigationFailureCode,
    message: string,
    readonly availableSites?: Array<{ id: string; name: string }>,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInsideDirectory(filePath: string, directoryPath: string) {
  const childPath = relative(directoryPath, filePath);
  return (
    childPath.length > 0 &&
    !childPath.startsWith("..") &&
    !isAbsolute(childPath)
  );
}

function requiredString(config: UnknownRecord, field: string, source: string) {
  const value = config[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConnectionError(
      "INVALID_CONNECTION",
      `Connected-site definition ${source} has an invalid ${field} field.`,
    );
  }
  return value.trim();
}

function parseWebUrl(value: string, field: string, source: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectionError(
      "INVALID_CONNECTION",
      `Connected-site definition ${source} has an invalid ${field}.`,
    );
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ConnectionError(
      "INVALID_CONNECTION",
      `Connected-site definition ${source} must use a normal HTTP(S) ${field}.`,
    );
  }
  return url;
}

function validateConnection(
  value: unknown,
  source: string,
): ResolvedConnectedSite {
  if (!isRecord(value)) {
    throw new ConnectionError(
      "INVALID_CONNECTION",
      `Connected-site definition ${source} must contain a JSON object.`,
    );
  }

  const id = requiredString(value, "id", source).toLowerCase();
  const name = requiredString(value, "name", source);
  const startUrl = requiredString(value, "startUrl", source);
  const allowedOrigin = requiredString(value, "allowedOrigin", source);
  const storageStatePath = requiredString(value, "storageStatePath", source);

  if (!SITE_ID_PATTERN.test(id)) {
    throw new ConnectionError(
      "INVALID_CONNECTION",
      `Connected-site definition ${source} has an invalid id.`,
    );
  }

  const parsedStartUrl = parseWebUrl(startUrl, "startUrl", source);
  const parsedAllowedOrigin = parseWebUrl(
    allowedOrigin,
    "allowedOrigin",
    source,
  );
  if (
    parsedAllowedOrigin.href !== parsedAllowedOrigin.origin + "/" ||
    parsedStartUrl.origin !== parsedAllowedOrigin.origin
  ) {
    throw new ConnectionError(
      "INVALID_CONNECTION",
      `Connected-site definition ${source} has inconsistent URL origins.`,
    );
  }

  if (isAbsolute(storageStatePath)) {
    throw new ConnectionError(
      "INVALID_CONNECTION",
      `Connected-site definition ${source} cannot use an absolute session path.`,
    );
  }

  const sessionsRoot = resolve(process.cwd(), SESSIONS_DIRECTORY);
  const sessionRelativePath = relative(SESSIONS_DIRECTORY, storageStatePath);
  const storageStateAbsolutePath = resolve(sessionsRoot, sessionRelativePath);
  if (!isInsideDirectory(storageStateAbsolutePath, sessionsRoot)) {
    throw new ConnectionError(
      "INVALID_CONNECTION",
      `Connected-site definition ${source} must reference a private KINO session file.`,
    );
  }

  return {
    id,
    name,
    startUrl: parsedStartUrl.href,
    allowedOrigin: parsedAllowedOrigin.origin,
    storageStatePath,
    storageStateAbsolutePath,
  };
}

export async function getConnectedSites(): Promise<ResolvedConnectedSite[]> {
  const directoryPath = resolve(process.cwd(), CONNECTIONS_DIRECTORY);
  let entries;

  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const definitions = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const sites: ResolvedConnectedSite[] = [];
  const seenIds = new Set<string>();

  for (const definition of definitions) {
    const definitionPath = resolve(directoryPath, definition.name);
    if (!isInsideDirectory(definitionPath, directoryPath)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(definitionPath, "utf8"));
    } catch {
      throw new ConnectionError(
        "INVALID_CONNECTION",
        `Connected-site definition ${definition.name} is not valid JSON.`,
      );
    }

    const site = validateConnection(parsed, definition.name);
    if (seenIds.has(site.id)) {
      throw new ConnectionError(
        "INVALID_CONNECTION",
        `Connected-site id ${site.id} is defined more than once.`,
      );
    }
    seenIds.add(site.id);
    sites.push(site);
  }

  return sites;
}

export async function getConnectedSite(site?: string) {
  const sites = await getConnectedSites();
  const summaries = sites.map(({ id, name }) => ({ id, name }));

  if (sites.length === 0) {
    throw new ConnectionError(
      "NO_CONNECTION",
      "No websites are connected to KINO.",
    );
  }

  const requestedSite = site?.trim().toLowerCase();
  if (!requestedSite) {
    if (sites.length === 1) return sites[0];
    throw new ConnectionError(
      "SITE_REQUIRED",
      "Multiple websites are connected. Specify which connected website to use.",
      summaries,
    );
  }

  const matches = sites.filter(
    (candidate) =>
      candidate.id.toLowerCase() === requestedSite ||
      candidate.name.toLowerCase() === requestedSite,
  );
  if (matches.length === 1) return matches[0];

  throw new ConnectionError(
    "SITE_NOT_FOUND",
    `No connected website matches ${JSON.stringify(site)}.`,
    summaries,
  );
}
