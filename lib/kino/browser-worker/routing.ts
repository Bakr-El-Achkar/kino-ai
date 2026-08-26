const URL_PATTERN = /https?:\/\/[^\s<>'"`]+/i;

export function requestedBrowserUrl(message: string) {
  const match = message.match(URL_PATTERN);
  if (!match) return null;
  return match[0].replace(/[.,!?;:)}\]]+$/, "");
}

export function browserRuntimeStateMessage() {
  return [
    "KINO_BROWSER_RUNTIME (server-generated):",
    JSON.stringify({
      arbitraryPublicUrls: true,
      semanticElementActionsOnly: true,
      modelSuppliedSelectors: false,
      credentialsBypassModel: true,
      authenticatedSessionsRuntimeOnly: true,
      writeConfirmationRequired: true,
      criticalStrongConfirmationRequired: true,
    }),
  ].join("\n");
}
