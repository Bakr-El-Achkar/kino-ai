import type { Locator } from "playwright";

export async function fillSensitiveField(locator: Locator, secret: string) {
  await locator.fill(secret, { timeout: 15_000 });
}

export async function verifySensitiveField(locator: Locator, secret: string) {
  return (await locator.inputValue()) === secret;
}
