const TOOLTIP_ID = 'transhover-tooltip';
const STATUS_ID = 'transhover-status';
const BLOCK_SELECTOR = 'p, li, dd, dt, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, section, article, div';
const WORD_CHAR = /[\p{L}\p{M}\p{N}'’-]/u;
const MAX_LENGTH = 4000;
const PAGE_CHUNK_CHARS = 3000;
const PAGE_CONCURRENCY = 3;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE', 'SVG', 'CANVAS', 'KBD', 'TEMPLATE']);

let mouse = null;
let pending = null;
// { originals: Map<Text, string>, pageTranslated: boolean } — все правки страницы, которые можно откатить
let pageState = null;

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

function modeFromKeys(e) {
  if (!e.ctrlKey) return null;
  if (e.shiftKey && e.altKey) return 'paragraph';
  if (e.shiftKey) return 'sentence';
  return 'word';
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

function translateAt(point, mode) {
  const hit = caretTextAt(point.x, point.y);
  if (!hit) return;

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

async function requestTranslation(point, block, start, end, text, mode) {
  showTooltip(point, 'Перевожу…');

  try {
    const res = await sendToBackground({ type: 'translate', text, mode });
    const { replaceInPlace } = await chrome.storage.local.get({ replaceInPlace: false });

    if (replaceInPlace) {
      replaceTextRange(block, start, end, res.text);
      hideTooltip();
    } else {
      showTooltip(point, res.text, false);
    }
  } catch (err) {
    showTooltip(point, err.message, true);
  }
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

function chunkNodes(nodes) {
  const chunks = [];
  let current = [];
  let length = 0;

  for (const node of nodes) {
    const size = node.data.trim().length;
    if (current.length && length + size > PAGE_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(node);
    length += size;
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

  const chunks = chunkNodes(nodes);
  let done = 0;
  let failed = 0;
  let lastError = '';

  showStatus(`Перевожу страницу: 0/${chunks.length}`);

  await runPool(chunks, PAGE_CONCURRENCY, async (chunk) => {
    try {
      const res = await sendToBackground({
        type: 'translatePage',
        items: chunk.map((n) => n.data.trim()),
      });
      if (pageState !== state) return; // пользователь вернул оригинал во время перевода

      chunk.forEach((node, i) => applyTranslation(state, node, res.texts[i]));
    } catch (err) {
      failed++;
      lastError = err.message;
    }
    done++;
    if (pageState === state) showStatus(`Перевожу страницу: ${done}/${chunks.length}`);
  });

  if (pageState !== state) return;

  if (failed) {
    showStatus(`Готово с ошибками (${failed} из ${chunks.length}): ${lastError}`, true);
  } else {
    showStatus('Страница переведена. Alt+Shift+T — вернуть оригинал.');
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
