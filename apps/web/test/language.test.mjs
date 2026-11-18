import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("the board uses browser preferences and honors a saved language", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  const preferences = new Map();
  const storage = { getItem: key => preferences.get(key) ?? null };
  const browser = { languages: ["fr-FR", "en-US"] };
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: browser });
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage, navigator: browser };
  try {
    const { App } = await server.ssrLoadModule("/src/App.tsx");
    const render = () => renderToStaticMarkup(React.createElement(App));
    assert.match(render(), />Overview</);
    browser.languages = ["fr-FR", "de-AT", "en"];
    assert.match(render(), />Überblick</);
    preferences.set("crewpip.language", "en");
    assert.match(render(), />Overview</);
    preferences.set("crewpip.language", "unknown");
    browser.languages = ["es-ES"];
    assert.match(render(), />Overview</);
    assert.match(render(), /<option value="de"[^>]*>Deutsch</);
  } finally {
    delete globalThis.window;
    delete globalThis.localStorage;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
    await server.close();
  }
});
