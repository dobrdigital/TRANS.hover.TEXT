const DEFAULTS = {
  provider: 'openrouter',
  openrouterKey: '',
  openaiKey: '',
  model: '',
  targetLang: 'Russian',
  replaceInPlace: false,
  autoExpert: true,
  expert: 'general',
  customPrompt: '',
};

const PROVIDER_MODELS = {
  openrouter: 'openai/gpt-4o-mini',
  openai: 'gpt-4o-mini',
};

const $ = (id) => document.getElementById(id);
const FIELDS = Object.keys(DEFAULTS);

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').dataset.error = String(isError);
  if (text) setTimeout(() => { $('status').textContent = ''; }, 2500);
}

function syncFormState() {
  $('expert').disabled = $('autoExpert').checked;
  $('modelHint').textContent = `По умолчанию: ${PROVIDER_MODELS[$('provider').value]}`;
  $('model').placeholder = PROVIDER_MODELS[$('provider').value];
}

function readForm() {
  const data = {};
  for (const key of FIELDS) {
    const el = $(key);
    data[key] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  return data;
}

$('provider').addEventListener('change', syncFormState);
$('autoExpert').addEventListener('change', syncFormState);

(async () => {
  const stored = await chrome.storage.local.get(DEFAULTS);
  for (const key of FIELDS) {
    const el = $(key);
    if (el.type === 'checkbox') el.checked = stored[key];
    else el.value = stored[key];
  }
  syncFormState();
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
