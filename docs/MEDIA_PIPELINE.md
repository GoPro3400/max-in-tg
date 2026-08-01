# Медиа-конвейер: фото, файлы, стикеры, голос, видео

Этот документ описывает, как `max-in-tg` передаёт **медиа** между MAX и Telegram —
в первую очередь **отправку фото/файлов из Telegram в MAX** и **анимированные
стикеры из MAX в Telegram**, потому что обе вещи завязаны на нетривиальное
поведение веб-клиента MAX.

У MAX нет публичного API, поэтому бот управляет веб-клиентом
(`https://web.max.ru/`) через Puppeteer/Chromium. Любая отправка/чтение — это
эмуляция действий пользователя в DOM.

---

## 1. Отправка фото и файлов: Telegram → MAX

### Проблема

Наивный способ — найти `input[type="file"]` в композере и выставить файл
(через `fileChooser.accept()` или `elementHandle.uploadFile()`) — **не работает**.
MAX не вешает обработчик на этот скрытый `input` напрямую: установка `input.files`
ничего не прикрепляет, превью в композере не появляется. Раньше из-за этого бот
**рапортовал успех, но фото не доходило** до собеседника.

### Как на самом деле устроено прикрепление в MAX

Кнопка-скрепка в композере (`button[aria-label="Upload file"]`,
`aria-haspopup="dialog"`) открывает **actions-меню** с пунктами:

| Пункт меню | aria-label | Назначение |
|------------|-----------|------------|
| Photo or video | `Photo or&nbsp;video` | фото и видео (инлайн-картинкой) |
| File | `File` | любой файл как документ |
| Contact | `Contact` | контакт |

> ⚠️ В `aria-label` пункта «Photo or video» используется **неразрывный пробел**
> (`&nbsp;`, U+00A0), поэтому селектор по точному совпадению не сработает —
> используем подстроку: `[aria-label*="Photo"]`.

Реальный file-chooser открывается **только после клика по пункту меню**.

### Алгоритм `sendFile()` (`src/adapters/maxWebClient.js`)

1. `ensureActiveChat(chatId)` — открыть нужный чат.
2. Кликнуть скрепку `selectors.attachButton` → открывается меню.
3. Дождаться пункта меню и кликнуть его, **выбирая по расширению файла**:
   - изображения/видео (`jpg/png/gif/webp/mp4/webm/mov/...`) → `attachMenuMedia` («Photo or video»);
   - всё остальное → `attachMenuFile` («File»).
4. Клик по пункту запускает file-chooser → `fileChooser.accept([path])`.
5. Подождать, пока вложение «осядет» в композере (`attachPreview`, мягкая проверка).
6. Запомнить число исходящих пузырей, нажать «Send message».
7. **Проверить доставку** (см. ниже).

### Честная проверка доставки

`sendFile` (и `sendText` через `submitComposer`) после отправки **подтверждают**,
что сообщение реально ушло:

- `sendFile` — ждёт, что число элементов `selectors.outgoingBubble`
  (`[data-bubbles-variant="outgoing"]`) **увеличилось**;
- `sendText` — ждёт, что композер **очистился**.

Если подтверждения нет за ~10 c — метод **бросает ошибку**, мост помечает доставку
`failed` и шлёт пользователю `⚠️ Failed to send to MAX`. Это исключает «тихие
потери», когда бот считает сообщение отправленным, а собеседник его не получил.

---

## 2. Анимированные стикеры: MAX → Telegram

MAX отдаёт анимированные стикеры как **Lottie** — векторную анимацию в формате
JSON (иногда уже gzip-сжатую). Цель — показать её в Telegram максимально близко к
оригиналу. Пайплайн с фолбэками:

```
MAX (Lottie JSON)
      │
      ├─ Strategy 0a (приоритет): Lottie пойман из сети  ──►  .tgs  ──►  sendSticker
      │     findNetworkLottie() → sticker-<id>.lottie          (gzip Lottie)   (нативный
      │     metadata.lottie = true   lottieToTgs()                              анимстикер TG)
      │
      ├─ Strategy 0b (фолбэк): кадры canvas (~1.7 c)
      │     captureStickerFrames() → PNG-кадры
      │       ├─ анимированный .gif  ──►  sendAnimation   (если кадры меняются)
      │       └─ VP9 .webm видео-стикер ──► sendSticker
      │
      └─ Static (последний фолбэк): один скриншот ──► sendPhoto, иначе текст «[Стикер]»
```

Подробно:

1. **Strategy 0a — сетевой Lottie (основной путь).** MAX рендерит стикер на
   `<canvas>`, который **в headless Chromium не отрисовывается надёжно**, поэтому
   опираемся не на пиксели, а на сам файл анимации, перехваченный из сети
   (`page.on('response')` → `findNetworkLottie()`). Сохраняем сырой `.lottie`,
   помечаем `metadata.lottie = true`.
   - `mediaService.lottieToTgs()` превращает Lottie в **Telegram `.tgs`** — это и
     есть gzip-Lottie (gzip применяется только если файл ещё не сжат; определяется
     по magic-байтам).
   - `telegramBot` отправляет `.tgs` через `sendSticker`. Telegram строго валидирует
     `.tgs`; при отказе — деградация в текстовый маркер `[Стикер]`.

2. **Strategy 0b — кадры canvas (фолбэк).** Если сетевого Lottie нет, семплируем
   `<canvas>` стикера ~1.7 c. Если кадры **меняются** (анимация играет) —
   кодируем их в:
   - **анимированный `.gif`** (`framesToGif`) → `sendAnimation` — то, что в TG
     выглядит как «гифка»; либо
   - **VP9 `.webm`** видео-стикер (`framesToWebm`) → `sendSticker`, с деградацией в
     `sendAnimation`/`sendVideo`/документ при отказе.

3. **Static.** Если кадры не меняются — стикер статичный: один скриншот →
   `sendPhoto`. В самом крайнем случае — текст `[Стикер]`, чтобы сообщение не
   потерялось.

> Кратко: **Lottie (JSON) → `.tgs` (gzip-Lottie) как основной формат**, а
> анимированный **GIF** (`sendAnimation`) и **`.webm`** видео-стикер — фолбэки,
> когда сетевой Lottie недоступен и приходится снимать кадры с canvas.

---

## 3. Остальные типы медиа (кратко)

| Тип | MAX → TG | TG → MAX |
|-----|----------|----------|
| Фото | `sendPhoto` | меню «Photo or video» (см. §1) |
| Голос | активный клик play → перехват аудио из сети → `.ogg`/`.opus`/`.mp3` → `sendVoice` | меню «File» |
| Видео-кружок | детект `videoMessage/videoCanvas` → `sendVideoNote` | меню «Photo or video» |
| Видео | перехват из сети → `sendVideo` | меню «Photo or video» |
| Документ | клик по ссылке скачивания → перехват → `sendDocument` | меню «File» |

Все сетевые захваты (`stickerUrls`/`voiceUrls`/`videoUrls`/`documentUrls`)
**тегируются `chatId`** на момент захвата — медиа из одного чата не может быть
ошибочно отдано в другой (фикс H5).

---

## 4. Конфигурируемые селекторы (`.env`)

Веб-интерфейс MAX может меняться; все ключевые селекторы переопределяются без
правки кода:

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `MAX_SELECTORS_ATTACH_BUTTON` | `button[aria-label="Upload file"]` | открыть меню вложений |
| `MAX_SELECTORS_ATTACH_MENU_MEDIA` | `button[role="menuitem"][aria-label*="Photo"]` | пункт «Photo or video» |
| `MAX_SELECTORS_ATTACH_MENU_FILE` | `button[role="menuitem"][aria-label*="File"]` | пункт «File» |
| `MAX_SELECTORS_ATTACH_PREVIEW` | `[data-testid="composer"] img, …` | признак прикреплённого вложения |
| `MAX_SELECTORS_OUTGOING_BUBBLE` | `[data-bubbles-variant="outgoing"]` | подсчёт исходящих для проверки доставки |
| `MAX_SELECTORS_SEND_BUTTON` | `button[aria-label="Send message"]` | кнопка отправки |
| `MAX_SELECTORS_MESSAGE_REPLY_BUTTON` | `button[aria-label="Reply"]` | кнопка «Ответить», появляющаяся при наведении на пузырь (путь Telegram→MAX reply) |
| `MAX_SELECTORS_COMPOSER_REPLY_ACTIVE` | `[data-testid="composer"] button.close` | признак включённого режима ответа: крестик на баннере цитаты (им же режим отменяется) |

### Если что-то снова сломалось

Симптом «бот говорит успех, но фото/стикер не доходит» почти всегда означает, что
MAX поменял вёрстку. Диагностика:

1. Включить debug-скриншоты: `sendFile` сам пишет `after-file-accept`,
   `attach-not-staged`, `after-send` в `logs/diagnostics/`.
2. Сверить актуальные `aria-label`/`role` пунктов меню и атрибут
   `data-bubbles-variant` исходящих сообщений в свежем HTML-дампе.
3. Переопределить соответствующий `MAX_SELECTORS_*` в `.env` — пересборка кода не
   нужна, достаточно пересоздать контейнер.
