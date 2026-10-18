# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

TRANS.hover.TEXT is a Manifest V3 Chromium extension: translate the word, sentence, paragraph, selected text or whole page under the cursor via OpenRouter or OpenAI.

## Working on it

- No build step, no dependencies. Load the folder via `chrome://extensions` → Developer mode → Load unpacked.
- Syntax check after every edit: `node --check background.js content.js cache.js popup.js experts.js`.
- Unit tests for the cache: `node --test tests/cache.test.mjs` (pass the file, not the directory: `node --test tests/` fails on Node 22).
- After changing `background.js` or `manifest.json`, reload the extension; content script changes apply to newly loaded pages.

## Architecture

- `background.js` — service worker. Calls the provider's chat-completions API and builds the system prompt (expert + mode rule + target language + custom prompt). Mode rules live in `MODES`.
- `experts.js` — the single list of experts (`EXPERTS`, `EXPERT_ORDER`, `AUTO_EXPERT_PROMPT`). Imported by the service worker with `importScripts` and loaded by the popup.
- `content.js` — runs on every page. Detects the hotkey combinations (word / sentence / paragraph), the page-translation hotkey and selection translation; renders the tooltip or replaces text in place. Whole-page translation replaces text nodes and keeps a map of originals for revert.
- `cache.js` — `TranslationCache`, an in-memory LRU loaded before `content.js`. The cache lives in the content script, so leaving the page drops it. Keys are `mode\0text`, page strings use the mode `page`. Changing any setting that affects the output (`TRANSLATION_SETTINGS` in `content.js`) clears it. Concurrent identical requests share one promise; failed requests are not kept.
- `popup.html` / `popup.js` — settings. Models are loaded from the provider's models endpoint; OpenRouter models can be filtered by price. API keys are stored per provider in `chrome.storage.local` and only the selected provider's key is shown.
- Settings are read from `chrome.storage.local` with the defaults declared in each file; keep the keys in sync when adding a setting.

## Notes

- Small free models sometimes ignore the instruction and ask for the text. The text is therefore wrapped in an explicit instruction in `background.js`.
- Keys never leave the browser except in the request to the chosen provider.
