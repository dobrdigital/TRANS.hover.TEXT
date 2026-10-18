const TOOLTIP_ID = 'transhover-tooltip';
const STATUS_ID = 'transhover-status';
const BLOCK_SELECTOR = 'p, li, dd, dt, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, section, article, div';
const WORD_CHAR = /[\p{L}\p{M}\p{N}'’-]/u;
const MAX_LENGTH = 4000;
const PAGE_CHUNK_CHARS = 3000;
const PAGE_CONCURRENCY = 3;
const CACHE_LIMIT = 2000;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE', 'SVG', 'CANVAS', 'KBD', 'TEMPLATE']);
// Настройки, от которых зависит текст перевода: при их изменении кеш сбрасывается.
const TRANSLATION_SETTINGS = ['provider', 'model', 'targetLang', 'expert', 'autoExpert', 'customPrompt'];

let mouse = null;
let pending = null;
// { originals: Map<Text, string>, pageTranslated: boolean } — все правки страницы, которые можно откатить
let pageState = null;
// Переводы этой страницы. Живёт в content script, поэтому пропадает вместе со страницей.
const cache = new TranslationCache(CACHE_LIMIT);

document.addEventListener('mousemove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
}, { passive: true });

// Ctrl — слово, Ctrl+Shift — предложение, Ctrl+Shift+Alt — абзац.
// Таймер нужен, чтобы при последовательном нажатии Ctrl → Shift → Alt
// перевод запускался один раз, в режиме последней комбинации.
document.addEventListener('keydown', (e) => {
  if (e.repeat || !['Control', 'Shift', 'Alt'].includes(e.key)) return;

  const mode = modeFromKeys(e);
  if (!mode || !mouse) return;

  clearTimeout(pending);
  pending = setTimeout(() => translateAt(mouse, mode), 120);
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideTooltip();
}, true);

document.addEventListener('mousedown', hideTooltip, true);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'togglePage') togglePage();
});

// Комбинации клавиш из настроек попапа: 'ctrl', 'ctrl+shift', 'ctrl+shift+alt' и т.д.
const HOTKEY_DEFAULTS = {
  hotkeyWord: 'ctrl',
  hotkeySentence: 'ctrl+shift',
  hotkeyParagraph: 'ctrl+shift+alt',
};
let hotkeys = {
  word: ['ctrl'],
  sentence: ['ctrl', 'shift'],
  paragraph: ['ctrl', 'shift', 'alt'],
};

async function loadHotkeys() {
  const s = await chrome.storage.local.get(HOTKEY_DEFAULTS);
  hotkeys = {
    word: s.hotkeyWord.split('+'),
    sentence: s.hotkeySentence.split('+'),
    paragraph: s.hotkeyParagraph.split('+'),
  };
}

loadHotkeys();

// Клавиша перевода всей страницы, например 'alt+a' (модификаторы + клавиша).
let pageHotkey = { key: 'a', ctrl: false, shift: false, alt: true };

function parseCombo(str) {
  const parts = str.split('+');
  return {
    key: parts[parts.length - 1],
    ctrl: parts.includes('ctrl'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
}

async function loadPageHotkey() {
  const s = await chrome.storage.local.get({ pageHotkey: 'alt+a' });
  pageHotkey = parseCombo(s.pageHotkey);
}

loadPageHotkey();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.hotkeyWord || changes.hotkeySentence || changes.hotkeyParagraph) loadHotkeys();
  if (changes.pageHotkey) loadPageHotkey();
  if (TRANSLATION_SETTINGS.some((key) => key in changes)) cache.clear();
});

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const el = e.target;
  // Не перехватываем клавиши, когда пользователь печатает в поле ввода.
  if (el?.isContentEditable || el?.closest?.('input, textarea, select')) return;

  const matches = e.key.toLowerCase() === pageHotkey.key
    && e.ctrlKey === pageHotkey.ctrl
    && e.shiftKey === pageHotkey.shift
    && e.altKey === pageHotkey.alt;
  if (!matches) return;

  e.preventDefault();
  togglePage();
}, true);

// Режим — тот, чья комбинация совпадает с нажатыми модификаторами целиком.
function modeFromKeys(e) {
  const pressed = [];
  if (e.ctrlKey) pressed.push('ctrl');
  if (e.shiftKey) pressed.push('shift');
  if (e.altKey) pressed.push('alt');

  for (const mode of ['word', 'sentence', 'paragraph']) {
    const combo = hotkeys[mode];
    if (combo.length === pressed.length && combo.every((k) => pressed.includes(k))) return mode;
  }
  return null;
}

/* ---------- перевод под курсором ---------- */

function caretTextAt(x, y) {
  const range = document.caretRangeFromPoint?.(x, y);
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;

  const el = document.elementFromPoint(x, y);
  if (el && (el.isContentEditable || el.closest('input, textarea, select'))) return null;

  return { node: range.startContainer, offset: range.startOffset };
}

// Границы слова вокруг индекса i внутри одной строки текста.
function wordBounds(text, i) {
  let start = i;
  let end = i;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;
  return { start, end };
}

function blockOf(node) {
  return node.parentElement?.closest(BLOCK_SELECTOR) ?? document.body;
}

// Границы предложения вокруг позиции pos в тексте блока.
function sentenceBounds(full, pos) {
  const endRe = /[.!?…]+["'»”)\]]*/g;
  let start = 0;
  let end = full.length;
  let m;

  while ((m = endRe.exec(full))) {
    const mEnd = m.index + m[0].length;
    if (mEnd <= pos) {
      start = mEnd;
    } else {
      end = mEnd;
      break;
    }
  }
  return { start, end };
}

async function translateAt(point, mode) {
  const hit = caretTextAt(point.x, point.y);
  if (!hit) return;

  // Если наведение идёт по выделенному мышкой фрагменту, переводим весь фрагмент.
  const settings = await chrome.storage.local.get({ useSelection: false, replaceInPlace: false });
  const sel = window.getSelection();
  if (settings.useSelection && sel && !sel.isCollapsed && sel.containsNode(hit.node, true)) {
    translateSelection(point, sel, settings.replaceInPlace);
    return;
  }

  const { node, offset } = hit;
  const block = blockOf(node);
  const full = block.textContent;

  // Позиция курсора в тексте блока и начало текстового узла в нём.
  const range = document.createRange();
  range.setStart(block, 0);
  range.setEnd(node, offset);
  const pos = range.toString().length;
  const nodeStart = pos - offset;

  let start;
  let end;

  if (mode === 'word') {
    const idx = WORD_CHAR.test(node.data[offset] ?? '') ? offset : offset - 1;
    if (!WORD_CHAR.test(node.data[idx] ?? '')) return;
    const b = wordBounds(node.data, idx);
    start = nodeStart + b.start;
    end = nodeStart + b.end;
  } else if (mode === 'sentence') {
    ({ start, end } = sentenceBounds(full, pos));
  } else {
    start = 0;
    end = full.length;
  }

  const text = full.slice(start, end).replace(/\s+/g, ' ').trim();
  if (!text) return;
  if (text.length > MAX_LENGTH) {
    showTooltip(point, `Текст слишком длинный (больше ${MAX_LENGTH} символов).`, true);
    return;
  }

  requestTranslation(point, block, start, end, text, mode);
}

function closestBlock(node) {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return el.closest(BLOCK_SELECTOR) ?? document.body;
}

async function translateSelection(point, sel, replaceInPlace) {
  const range = sel.getRangeAt(0);
  const text = range.toString().replace(/\s+/g, ' ').trim();
  if (!text) return;
  if (text.length > MAX_LENGTH) {
    showTooltip(point, `Выделенный текст слишком длинный (больше ${MAX_LENGTH} символов).`, true);
    return;
  }

  const startBlock = closestBlock(range.startContainer);
  const sameBlock = startBlock === closestBlock(range.endContainer);

  showTooltip(point, 'Перевожу выделение…');
  try {
    const translated = await cachedTranslate(text, 'selection');

    if (replaceInPlace && sameBlock) {
      const before = document.createRange();
      before.setStart(startBlock, 0);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length;
      replaceTextRange(startBlock, start, start + range.toString().length, translated);
      hideTooltip();
    } else {
      const note = replaceInPlace ? '\n\n(замена работает только внутри одного блока)' : '';
      showTooltip(point, translated + note, false);
    }
  } catch (err) {
    showTooltip(point, err.message, true);
  }
}

async function requestTranslation(point, block, start, end, text, mode) {
  showTooltip(point, 'Перевожу…');

  try {
    const translated = await cachedTranslate(text, mode);
    const { replaceInPlace } = await chrome.storage.local.get({ replaceInPlace: false });

    if (replaceInPlace) {
      replaceTextRange(block, start, end, translated);
      hideTooltip();
    } else {
      showTooltip(point, translated, false);
    }
  } catch (err) {
    showTooltip(point, err.message, true);
  }
}

/* ---------- кеш переводов ---------- */

// Перевод зависит от режима (слово, предложение, абзац...), поэтому режим входит в ключ.
function cacheKey(mode, text) {
  return `${mode}\u0000${text}`;
}

// Одновременные одинаковые запросы разделяют один вызов модели.
// Ошибка не сохраняется, поэтому следующая попытка пойдёт заново.
function cachedTranslate(text, mode) {
  return cache.getOrCreate(cacheKey(mode, text), async () => {
    const res = await sendToBackground({ type: 'translate', text, mode });
    if (typeof res?.text !== 'string') throw new Error('Модель вернула пустой ответ.');
    return res.text;
  });
}

// Заменяет текст в диапазоне [start, end) блока на newText.
// Элементы (ссылки, выделения) сохраняются: их текстовые узлы
// очищаются, а новый текст вставляется в первый затронутый узел.
function replaceTextRange(block, start, end, newText) {
  const state = ensureState();

  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  let cursor = 0;
  let placed = false;
  for (const node of nodes) {
    const nodeFrom = cursor;
    const nodeTo = cursor + node.data.length;
    cursor = nodeTo;

    const from = Math.max(start, nodeFrom);
    const to = Math.min(end, nodeTo);
    if (from >= to) continue;

    if (!state.originals.has(node)) state.originals.set(node, node.data);

    const before = node.data.slice(0, from - nodeFrom);
    const after = node.data.slice(to - nodeFrom);
    if (!placed) {
      node.data = before + newText + after;
      placed = true;
    } else {
      node.data = before + after;
    }
  }
}

/* ---------- перевод всей страницы ---------- */

function ensureState() {
  if (!pageState) pageState = { originals: new Map(), pageTranslated: false };
  return pageState;
}

function togglePage() {
  if (pageState?.pageTranslated) {
    revertPage();
  } else {
    translatePage();
  }
}

function collectTextNodes() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.data.trim().length < 2 || !/\p{L}/u.test(node.data)) return NodeFilter.FILTER_REJECT;

      for (let el = node.parentElement; el; el = el.parentElement) {
        if (SKIP_TAGS.has(el.tagName) || el.isContentEditable || el.id === TOOLTIP_ID || el.id === STATUS_ID) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

// Одинаковые строки (меню, кнопки, повторы) собираются в одну группу:
// переводим строку один раз, а результат применяем ко всем её узлам.
function groupNodesByText(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const text = node.data.trim();
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(node);
  }
  return groups;
}

// Делит строки на пачки примерно по PAGE_CHUNK_CHARS символов — по одной пачке на запрос.
function chunkTexts(texts) {
  const chunks = [];
  let current = [];
  let length = 0;

  for (const text of texts) {
    if (current.length && length + text.length > PAGE_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(text);
    length += text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function translatePage() {
  const nodes = collectTextNodes();
  if (!nodes.length) {
    showStatus('На странице нет текста для перевода.', true);
    return;
  }

  const state = ensureState();
  state.pageTranslated = true;

  // Строки, которые уже переведены на этой странице, берём из кеша без запроса к модели.
  const groups = groupNodesByText(nodes);
  const translations = new Map();
  const missing = [];
  for (const text of groups.keys()) {
    const hit = cache.get(cacheKey('page', text));
    if (hit === undefined) {
      missing.push(text);
    } else {
      translations.set(text, hit);
    }
  }
  const fromCache = translations.size;
  for (const [text, translated] of translations) {
    for (const node of groups.get(text)) applyTranslation(state, node, translated);
  }

  const chunks = chunkTexts(missing);
  let done = 0;
  let failed = 0;
  let lastError = '';

  showStatus(`Перевожу страницу: 0/${chunks.length}`);

  await runPool(chunks, PAGE_CONCURRENCY, async (chunk) => {
    try {
      const res = await sendToBackground({ type: 'translatePage', items: chunk });
      chunk.forEach((text, i) => {
        const translated = res.texts[i];
        if (!translated) return;

        // Кеш заполняем всегда: перевод верный, даже если страницу уже вернули в оригинал.
        cache.set(cacheKey('page', text), translated);
        if (pageState === state) {
          for (const node of groups.get(text)) applyTranslation(state, node, translated);
        }
      });
    } catch (err) {
      failed++;
      lastError = err.message;
    }
    done++;
    if (pageState === state) showStatus(`Перевожу страницу: ${done}/${chunks.length}`);
  });

  if (pageState !== state) return;

  const summary = `новых фрагментов: ${missing.length}, из кеша: ${fromCache}`;
  if (failed) {
    showStatus(`Готово с ошибками (${failed} из ${chunks.length}, ${summary}): ${lastError}`, true);
  } else {
    showStatus(`Страница переведена (${summary}). Повторное нажатие горячей клавиши вернёт оригинал.`);
  }
}

function applyTranslation(state, node, translated) {
  if (!translated || !node.isConnected) return;

  const original = node.data;
  const lead = original.match(/^\s*/)[0];
  const tail = original.match(/\s*$/)[0];

  if (!state.originals.has(node)) state.originals.set(node, original);
  node.data = lead + translated.trim() + tail;
}

function revertPage() {
  if (!pageState) return;

  for (const [node, text] of pageState.originals) {
    node.data = text;
  }
  pageState = null;
  showStatus('Оригинал восстановлен.');
  setTimeout(hideStatus, 2000);
}

async function runPool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/* ---------- связь с фоновым скриптом ---------- */

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (res?.error) {
          reject(new Error(res.error));
        } else {
          resolve(res);
        }
      });
    } catch {
      // Расширение перезагрузили или отключили, пока страница была открыта.
      reject(new Error('Обновите страницу: расширение было перезагружено.'));
    }
  });
}

/* ---------- интерфейс ---------- */

// Подсказка появляется над словом; если у верхнего края экрана места нет — под ним.
function showTooltip(point, text, isError = false) {
  let el = document.getElementById(TOOLTIP_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = TOOLTIP_ID;
    document.documentElement.append(el);
  }

  const above = point.y > 60;
  el.textContent = text;
  el.dataset.error = String(isError);
  el.style.left = `${Math.max(8, Math.min(point.x + 12, window.innerWidth - 340))}px`;
  el.style.top = above ? `${point.y - 12}px` : `${point.y + 20}px`;
  el.style.transform = above ? 'translateY(-100%)' : 'none';
  el.hidden = false;
}

function hideTooltip() {
  const el = document.getElementById(TOOLTIP_ID);
  if (el) el.hidden = true;
}

function showStatus(text, isError = false) {
  let el = document.getElementById(STATUS_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = STATUS_ID;
    document.documentElement.append(el);
  }

  el.textContent = text;
  el.dataset.error = String(isError);
  el.hidden = false;
}

function hideStatus() {
  const el = document.getElementById(STATUS_ID);
  if (el) el.hidden = true;
}
