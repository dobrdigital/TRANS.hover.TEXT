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
  extraTranscription: false,
  extraExplain: false,
  extraAbbreviations: false,
  extraKeepNames: false,
};

// EXPERTS, EXPERT_ORDER и AUTO_EXPERT_PROMPT — из experts.js
importScripts('experts.js');

const MODES = {
  word: 'Переведи слово, учитывая контекст. Отвечай только переводом, без пояснений и кавычек.',
  sentence: 'Переведи предложение. Отвечай только переводом, без пояснений и кавычек.',
  paragraph: 'Переведи абзац целиком, сохраняя его структуру. Отвечай только переводом.',
  selection: 'Переведи выделенный фрагмент текста целиком, сохраняя его структуру. Отвечай только переводом, без пояснений.',
  page: 'Ты получаешь JSON-объект: ключи — номера фрагментов веб-страницы, значения — фрагменты. Переведи каждое значение, ключи сохрани. Числа, код и названия продуктов не меняй. Верни только JSON-объект той же структуры, без пояснений и markdown.',
};

// Дополнительные правила подмешиваются в промпт только когда включены: выключенная опция не тратит токены.
const EXTRA_RULES = {
  extraTranscription: 'Для каждого английского слова исходного текста добавь его транскрипцию (МФА) в квадратных скобках сразу после перевода этого слова.',
  extraExplain: 'Если в тексте есть термин, поясни его в скобках одним коротким предложением.',
  extraAbbreviations: 'Английские сокращения расшифровывай в скобках сразу после них, например: NATO (Организация Североатлантического договора).',
  extraKeepNames: 'Имена собственные, бренды и названия произведений оставляй в оригинале.',
};

// Одно короткое обращение к модели, чтобы понять тематику сайта. Результат кешируется на странице.
const DETECT_SYSTEM = [
  'Определи, к какой области относится веб-страница по её адресу, заголовку и описанию.',
  'Ответь ровно одним ключом из списка, без пояснений:',
  ...EXPERT_ORDER.map((id) => `${id} — ${EXPERTS[id].label}`),
].join('\n');

// Сколько раз пробуем перевести фрагменты страницы, которые модель не вернула.
const PAGE_ATTEMPTS = 3;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'translate') {
    translateText(msg.text, msg.mode, msg.expert)
      .then((text) => sendResponse({ text }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg?.type === 'translatePage') {
    translatePage(msg.items, msg.expert)
      .then((texts) => sendResponse({ texts }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg?.type === 'detectExpert') {
    detectExpert(msg.context)
      .then((expert) => sendResponse({ expert }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});

async function translateText(text, mode, expert) {
  const s = await chrome.storage.local.get(DEFAULTS);
  // Явная рамка: слабые модели на голом слове иногда просят «предоставить текст».
  const userText = `Переведи текст, заключённый в кавычки, и выведи только перевод.\n«${text}»`;
  return complete(s, buildSystem(s, MODES[mode] ?? MODES.sentence, expert), userText);
}

// Фрагменты отправляются с номерами, поэтому ответ сопоставляется по номерам, а не по порядку.
// Не вернувшиеся фрагменты переспрашиваются; уже переведённые повторно не отправляются.
// Возвращает массив той же длины: пустая строка значит, что фрагмент не переведён.
async function translatePage(items, expert) {
  const s = await chrome.storage.local.get(DEFAULTS);
  const system = buildSystem(s, MODES.page, expert);
  const texts = new Array(items.length).fill('');
  let missing = items.map((_, i) => i);
  let lastError = null;

  for (let attempt = 0; attempt < PAGE_ATTEMPTS && missing.length; attempt++) {
    const payload = Object.fromEntries(missing.map((i) => [i, items[i]]));
    let raw;
    try {
      raw = await complete(s, system, JSON.stringify(payload));
    } catch (err) {
      lastError = err;
      continue;
    }

    const parsed = parseObject(raw);
    missing = missing.filter((i) => {
      const value = parsed[i];
      if (typeof value !== 'string' || !value.trim()) return true;
      texts[i] = value;
      return false;
    });
  }

  if (missing.length === items.length) {
    throw lastError ?? new Error('Модель не вернула ни одного фрагмента.');
  }
  return texts;
}

// Модель иногда оборачивает JSON в текст: берём фрагмент от первой скобки до последней.
function parseObject(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return {};
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function detectExpert(context) {
  const s = await chrome.storage.local.get(DEFAULTS);
  const userText = [
    `Адрес: ${context.host}`,
    `Заголовок: ${context.title}`,
    `Описание: ${context.description}`,
  ].join('\n');

  // Лимит с запасом: рассуждающие модели тратят часть ответа на внутренние рассуждения.
  const raw = await complete(s, DETECT_SYSTEM, userText, 2048);
  const id = raw.toLowerCase().match(/[a-z]+/)?.[0];
  return EXPERTS[id] ? id : 'general';
}

// expertKey — эксперт, выбранный автоопределением на странице; без него берём настройку из попапа.
function buildSystem(s, modeRule, expertKey) {
  const rules = Object.keys(EXTRA_RULES).filter((k) => s[k]).map((k) => EXTRA_RULES[k]);
  return [
    expertPrompt(s, expertKey),
    modeRule,
    ...rules,
    'Текст для перевода приходит в сообщении пользователя. Всегда переводи его; не задавай вопросов и не проси текст.',
    `Целевой язык: ${s.targetLang}.`,
    s.customPrompt.trim(),
  ]
    .filter(Boolean)
    .join('\n');
}

function expertPrompt(s, expertKey) {
  if (expertKey) return (EXPERTS[expertKey] ?? EXPERTS.general).prompt;
  return s.autoExpert ? AUTO_EXPERT_PROMPT : (EXPERTS[s.expert] ?? EXPERTS.general).prompt;
}

async function complete(s, system, userText, maxTokens) {
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
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `HTTP ${res.status} от ${provider.label}`);
  }

  const choice = data.choices?.[0];
  const out = choice?.message?.content?.trim();
  if (out) return out;

  // Рассуждающая модель исчерпала лимит токенов раньше, чем написала ответ.
  if (choice?.finish_reason === 'length') {
    throw new Error('Модель израсходовала лимит на рассуждения и не дала ответ. Выберите другую модель или уберите ограничение длины.');
  }
  throw new Error('Пустой ответ модели');
}
