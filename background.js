const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keyField: 'openrouterKey',
    defaultModel: 'openai/gpt-4o-mini',
    headers: { 'X-Title': 'TransHover' },
  },
  openai: {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    keyField: 'openaiKey',
    defaultModel: 'gpt-4o-mini',
    headers: {},
  },
};

const DEFAULTS = {
  provider: 'openrouter',
  openrouterKey: '',
  openaiKey: '',
  model: '',
  targetLang: 'Russian',
  autoExpert: true,
  expert: 'general',
  customPrompt: '',
};

const EXPERTS = {
  general: 'Ты переводчик общего назначения. Сохраняй смысл и естественность текста.',
  literary: 'Ты литературный переводчик. Сохраняй стиль, ритм, образность и интонацию автора; идиомы передавай по смыслу.',
  economic: 'Ты переводчик экономических и финансовых текстов. Используй точную терминологию (рынки, отчётность, макроэкономика) и не упрощай термины.',
  medical: 'Ты переводчик медицинских текстов. Используй точную медицинскую терминологию, сохраняй дозировки, единицы измерения и названия препаратов.',
  technical: 'Ты переводчик технической документации. Сохраняй точность; названия API, команд, кода и единицы измерения оставляй без изменений.',
  auto: 'Сначала определи предметную область текста (литература, экономика, медицина, техника или общий текст) и выбери подходящий стиль и терминологию.',
};

const MODES = {
  word: 'Переведи слово, учитывая контекст. Отвечай только переводом, без пояснений и кавычек.',
  sentence: 'Переведи предложение. Отвечай только переводом, без пояснений и кавычек.',
  paragraph: 'Переведи абзац целиком, сохраняя его структуру. Отвечай только переводом.',
  selection: 'Переведи выделенный фрагмент текста целиком, сохраняя его структуру. Отвечай только переводом, без пояснений.',
  page: 'Ты получаешь JSON-массив фрагментов веб-страницы. Переведи каждый фрагмент, сохрани порядок и количество элементов. Числа, код и названия продуктов не меняй. Верни только JSON-массив строк без пояснений и markdown.',
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'translate') {
    translateText(msg.text, msg.mode)
      .then((text) => sendResponse({ text }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg?.type === 'translatePage') {
    translatePage(msg.items)
      .then((texts) => sendResponse({ texts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'translate-page') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'togglePage' }).catch(() => {});
  }
});

async function translateText(text, mode) {
  const s = await chrome.storage.local.get(DEFAULTS);
  return complete(s, buildSystem(s, MODES[mode] ?? MODES.sentence), text);
}

async function translatePage(items) {
  const s = await chrome.storage.local.get(DEFAULTS);
  const raw = await complete(s, buildSystem(s, MODES.page), JSON.stringify(items));

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('Модель вернула не JSON-массив');
  }

  if (!Array.isArray(parsed) || parsed.length !== items.length) {
    throw new Error('Модель вернула массив неверной длины');
  }
  return parsed.map(String);
}

function buildSystem(s, modeRule) {
  const expert = s.autoExpert ? 'auto' : s.expert;
  return [
    EXPERTS[expert] ?? EXPERTS.general,
    modeRule,
    `Целевой язык: ${s.targetLang}.`,
    s.customPrompt.trim(),
  ]
    .filter(Boolean)
    .join('\n');
}

async function complete(s, system, userText) {
  const provider = PROVIDERS[s.provider] ?? PROVIDERS.openrouter;
  const key = s[provider.keyField];
  if (!key) {
    throw new Error(`Укажите API-ключ ${provider.label} в настройках расширения.`);
  }

  const res = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      ...provider.headers,
    },
    body: JSON.stringify({
      model: s.model.trim() || provider.defaultModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `HTTP ${res.status} от ${provider.label}`);
  }

  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('Пустой ответ модели');
  return out;
}
