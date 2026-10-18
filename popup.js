const DEFAULTS = {
  provider: 'openrouter',
  openrouterKey: '',
  openaiKey: '',
  model: '',
  targetLang: 'Russian',
  replaceInPlace: false,
  useSelection: false,
  autoExpert: true,
  expert: 'general',
  customPrompt: '',
};

const DEFAULT_MODELS = {
  openrouter: 'openai/gpt-4o-mini',
  openai: 'gpt-4o-mini',
};

// Источники списка моделей. У OpenRouter есть цены, у OpenAI — нет.
const MODEL_SOURCES = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/models',
    keyField: 'openrouterKey',
    parse: (data) => data.data.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      free: m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0),
    })),
    hasPricing: true,
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    keyField: 'openaiKey',
    parse: (data) => data.data.map((m) => ({ id: m.id, name: m.id, free: null })),
    hasPricing: false,
  },
};

const $ = (id) => document.getElementById(id);
const FIELDS = Object.keys(DEFAULTS);

let models = [];
let filter = 'free'; // 'free' | 'paid'

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').dataset.error = String(isError);
  if (text) setTimeout(() => { $('status').textContent = ''; }, 2500);
}

function currentProvider() {
  return $('provider').value;
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
  const key = $(source.keyField).value.trim();

  if (provider === 'openai' && !key) {
    models = [];
    renderModels(selected);
    setStatus('Введите ключ OpenAI, чтобы загрузить модели.', true);
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
  return data;
}

function syncExpertState() {
  $('expert').disabled = $('autoExpert').checked;
}

$('provider').addEventListener('change', async () => {
  // Модель у каждого провайдера своя, сбрасываем выбор.
  await loadModels('');
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

$('reloadModels').addEventListener('click', () => loadModels($('model').value));

// Список моделей подгружаем сразу, как только введён ключ.
for (const [provider, source] of Object.entries(MODEL_SOURCES)) {
  $(source.keyField).addEventListener('change', () => {
    if (currentProvider() === provider) loadModels($('model').value);
  });
}

(async () => {
  const stored = await chrome.storage.local.get(DEFAULTS);
  for (const key of FIELDS) {
    if (key === 'model') continue;
    const el = $(key);
    if (el.type === 'checkbox') el.checked = stored[key];
    else el.value = stored[key];
  }
  syncExpertState();
  await loadModels(stored.model);
})();

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set(readForm());
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
