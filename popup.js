const DEFAULTS = {
  provider: 'openrouter',
  openrouterKey: '',
  openaiKey: '',
  model: '',
  targetLang: 'Russian',
  replaceInPlace: false,
  useSelection: false,
  hotkeyWord: 'ctrl',
  hotkeySentence: 'ctrl+shift',
  hotkeyParagraph: 'ctrl+shift+alt',
  pageHotkey: 'alt+a',
  autoExpert: true,
  expert: 'general',
  customPrompt: '',
};

// Ключи не входят в обычные поля формы: они показываются только для выбранного провайдера.
const KEY_FIELDS = ['openrouterKey', 'openaiKey'];
const FIELDS = Object.keys(DEFAULTS).filter((k) => !KEY_FIELDS.includes(k));

const DEFAULT_MODELS = {
  openrouter: 'openai/gpt-4o-mini',
  openai: 'gpt-4o-mini',
};

const PROVIDER_LABELS = {
  openrouter: 'Ключ OpenRouter',
  openai: 'Ключ OpenAI',
};

// Источники списка моделей. У OpenRouter есть цены, у OpenAI — нет.
const MODEL_SOURCES = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/models',
    parse: (data) => data.data.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      free: m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0),
    })),
    hasPricing: true,
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    parse: (data) => data.data.map((m) => ({ id: m.id, name: m.id, free: null })),
    hasPricing: false,
  },
};

const $ = (id) => document.getElementById(id);

// Список экспертов строится из experts.js, чтобы не дублировать его в двух местах.
for (const id of EXPERT_ORDER) {
  $('expert').append(new Option(EXPERTS[id].label, id));
}

// Варианты клавиш: значение совпадает с тем, что читает content.js (split по '+').
const HOTKEY_OPTIONS = [
  ['ctrl', 'Control'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
  ['ctrl+shift', 'Control + Shift'],
  ['ctrl+alt', 'Control + Alt'],
  ['alt+shift', 'Alt + Shift'],
  ['ctrl+shift+alt', 'Control + Shift + Alt'],
];

for (const id of ['hotkeyWord', 'hotkeySentence', 'hotkeyParagraph']) {
  for (const [value, label] of HOTKEY_OPTIONS) {
    $(id).append(new Option(label, value));
  }
}

let models = [];
let filter = 'free'; // 'free' | 'paid'
let keys = { openrouterKey: '', openaiKey: '' };
let activeProvider = 'openrouter';

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').dataset.error = String(isError);
  if (text) setTimeout(() => { $('status').textContent = ''; }, 2500);
}

function currentProvider() {
  return $('provider').value;
}

// Переносим то, что сейчас введено в поле, в память для текущего провайдера.
function captureKeyFromInput() {
  keys[`${activeProvider}Key`] = $('apiKey').value.trim();
}

function showKeyForProvider(provider) {
  activeProvider = provider;
  $('keyLabel').textContent = PROVIDER_LABELS[provider];
  $('apiKey').value = keys[`${provider}Key`] ?? '';
}

function renderFilterButtons() {
  const hasPricing = MODEL_SOURCES[currentProvider()].hasPricing;
  $('fltFree').disabled = !hasPricing;
  $('fltPaid').disabled = !hasPricing;
  $('fltFree').classList.toggle('active', hasPricing && filter === 'free');
  $('fltPaid').classList.toggle('active', hasPricing && filter === 'paid');
  $('modelHint').textContent = hasPricing
    ? `Моделей: ${models.length}. По умолчанию: ${DEFAULT_MODELS.openrouter}`
    : `OpenAI не отдаёт цены, фильтр недоступен. Моделей: ${models.length}`;
}

function renderModels(selected) {
  const select = $('model');
  const hasPricing = MODEL_SOURCES[currentProvider()].hasPricing;
  const visible = models.filter((m) => !hasPricing || (filter === 'free' ? m.free : !m.free));

  select.innerHTML = '';
  select.append(new Option(`По умолчанию (${DEFAULT_MODELS[currentProvider()]})`, ''));
  for (const m of visible) {
    select.append(new Option(m.name === m.id ? m.id : `${m.name} — ${m.id}`, m.id));
  }
  // Сохранённая модель остаётся выбранной, даже если её нет в текущем фильтре.
  if (selected && !visible.some((m) => m.id === selected)) {
    select.append(new Option(`${selected} (сохранено)`, selected));
  }
  select.value = selected ?? '';
  renderFilterButtons();
}

async function loadModels(selected) {
  const provider = currentProvider();
  const source = MODEL_SOURCES[provider];
  const key = (keys[`${provider}Key`] ?? '').trim();

  if (provider === 'openai' && !key) {
    models = [];
    renderModels(selected);
    setStatus('Введите ключ OpenAI в настройках (⚙), чтобы загрузить модели.', true);
    return;
  }

  try {
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    const res = await fetch(source.url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    models = source.parse(await res.json()).sort((a, b) => a.id.localeCompare(b.id));
    renderModels(selected);
    setStatus(`Загружено моделей: ${models.length}`);
  } catch (err) {
    models = [];
    renderModels(selected);
    setStatus(`Не удалось загрузить модели: ${err.message}`, true);
  }
}

function readForm() {
  const data = {};
  for (const key of FIELDS) {
    const el = $(key);
    data[key] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  captureKeyFromInput();
  return { ...data, ...keys };
}

function syncExpertState() {
  $('expert').disabled = $('autoExpert').checked;
}

$('settingsBtn').addEventListener('click', () => {
  const open = $('settingsPanel').hidden;
  $('settingsPanel').hidden = !open;
  $('settingsBtn').classList.toggle('active', open);
});

$('closeSettings').addEventListener('click', () => {
  $('settingsPanel').hidden = true;
  $('settingsBtn').classList.remove('active');
});

$('provider').addEventListener('change', async () => {
  captureKeyFromInput();
  showKeyForProvider(currentProvider());
  // Модель у каждого провайдера своя, сбрасываем выбор.
  await loadModels('');
});

// Ключ привязан к провайдеру: когда пользователь закончил ввод, подгружаем модели.
$('apiKey').addEventListener('change', () => {
  captureKeyFromInput();
  loadModels($('model').value);
});

$('autoExpert').addEventListener('change', syncExpertState);

$('fltFree').addEventListener('click', () => {
  filter = 'free';
  renderModels($('model').value);
});

$('fltPaid').addEventListener('click', () => {
  filter = 'paid';
  renderModels($('model').value);
});

$('reloadModels').addEventListener('click', () => {
  captureKeyFromInput();
  loadModels($('model').value);
});

// Запись комбинации: нажмите клавиши в поле, например Alt + A. Нужен хотя бы один модификатор.
$('pageHotkey').addEventListener('keydown', (e) => {
  e.preventDefault();
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(e.key.toLowerCase());
  $('pageHotkey').value = parts.join('+');
});

$('save').addEventListener('click', async () => {
  const form = readForm();

  const hotkeys = [form.hotkeyWord, form.hotkeySentence, form.hotkeyParagraph];
  if (new Set(hotkeys).size !== hotkeys.length) {
    setStatus('Горячие клавиши для слова, предложения и абзаца должны отличаться.', true);
    return;
  }

  const pageParts = form.pageHotkey.split('+');
  if (pageParts.length < 2 || !['ctrl', 'alt', 'shift'].some((m) => pageParts.includes(m))) {
    setStatus('Клавиша страницы должна содержать модификатор: Ctrl, Alt или Shift.', true);
    return;
  }

  await chrome.storage.local.set(form);
  setStatus('Сохранено');
});

$('translatePage').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('Не удалось найти активную вкладку.', true);
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'togglePage' });
    setStatus('Запущено. Статус появится на странице.');
  } catch {
    setStatus('Страница не поддерживает перевод. Обновите её и попробуйте снова.', true);
  }
});

(async () => {
  const stored = await chrome.storage.local.get(DEFAULTS);
  for (const key of FIELDS) {
    if (key === 'model') continue;
    const el = $(key);
    if (el.type === 'checkbox') el.checked = stored[key];
    else el.value = stored[key];
  }
  keys = { openrouterKey: stored.openrouterKey, openaiKey: stored.openaiKey };
  $('provider').value = stored.provider;
  showKeyForProvider(stored.provider);
  syncExpertState();
  await loadModels(stored.model);
})();
