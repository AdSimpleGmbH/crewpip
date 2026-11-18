/**
 * Alle Aufrufe an den Daemon gehen hier durch, damit das Token an genau einer Stelle sitzt.
 * Der Daemon setzt es beim Ausliefern der Startseite ein; eine fremde Webseite kann sie
 * wegen der Herkunftsregeln des Browsers nicht lesen und kommt so nicht an das Token.
 */
const TOKEN: string = (window as unknown as { __MNGBOARD_TOKEN__?: string }).__MNGBOARD_TOKEN__ ?? "";

export function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (TOKEN) headers.set("x-mngboard-token", TOKEN);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(path, { ...init, headers });
}

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // WebSockets erlauben keine eigenen Kopfzeilen, deshalb hier über die Adresse.
  return `${proto}://${location.host}/ws${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
}
