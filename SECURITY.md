# Безопасность

`max-in-tg` держит живую сессию личного мессенджера: в `data/chrome-profile` лежит
залогиненный аккаунт MAX, в `.env` — токен Telegram-бота, а в SQLite — реальная
переписка, включая сообщения людей, которые о существовании моста не знают. Поэтому
уязвимость здесь стоит дороже, чем в обычном хобби-проекте, и сообщать о ней нужно не
публичным issue.

---

## Как Сообщить Об Уязвимости

**Не открывай публичный issue и не пиши о находке в обсуждениях.**

Используй приватный канал GitHub: вкладка **Security** репозитория →
**Report a vulnerability** (Private Vulnerability Reporting). Отчёт видят только
мейнтейнер и ты.

Что полезно приложить:

- что ломается и к чему это приводит (утечка сессии, чужая переписка, обход владельца);
- шаги воспроизведения или PoC;
- версия — коммит (`git rev-parse HEAD`) и как запущено (Docker / `docker-compose.prod.yml`);
- **без реальных секретов**: не прикладывай токен бота, QR-код, содержимое
  `data/chrome-profile` и недоредактированные дампы `/diagnostics`.

Условия честно: это личный проект одного человека. **Награды за находки нет**, ответ —
по возможности; ориентир — несколько дней на первый ответ, а на исправление столько,
сколько потребуется. Раскрытие — по согласованию, после того как фикс уехал в `main`.

---

## Модель Угроз (Что В Зоне Ответственности)

Мост рассчитан на **одного пользователя и один аккаунт MAX** на своём собственном
сервере. Мультиарендности нет, изоляции между пользователями нет, и оператор по
определению доверяет машине, на которой всё это запущено.

**Чувствительные активы:**

| Актив | Почему важен |
|---|---|
| `TELEGRAM_BOT_TOKEN` в `.env` | Полный контроль над ботом: чужой токен = чужой мост |
| `data/chrome-profile` | Активная сессия MAX. Копия каталога = вход в аккаунт без QR и пароля |
| `data/max-in-tg.sqlite` | Вся переписка, прошедшая через мост, и привязки чатов |
| `logs/diagnostics/*` | HTML-дампы страницы MAX и **скриншоты окна с открытым чатом** |
| QR-код входа | Учётные данные: кто отсканировал, тот привязал устройство к аккаунту |

**В зоне ответственности** (сообщай о таком):

- обход проверки владельца — команда выполняется от чужого Telegram-аккаунта;
- утечка QR-кода, токена или содержимого профиля Chrome в логи, дампы или чужой чат;
- маршрутизация сообщения в чужой чат MAX или в чужую тему Telegram;
- запись за пределы `data/ tmp/ logs/`, path traversal в именах файлов;
- выход из контейнера, повышение привилегий, RCE через обработку медиа.

**Вне зоны ответственности:**

- изменение вёрстки MAX Web, ломающее селекторы (это ожидаемая хрупкость — см.
  «Известные ограничения» в README и команду `/check`);
- вопросы соблюдения ToS MAX и блокировки аккаунта — см. «Дисклеймер» в README;
- то, что скриншот `/diagnostics` показывает открытую переписку: это
  задокументированное поведение, а не дефект (раздел «Безопасность» в README);
- уязвимости самих MAX, Telegram или Docker;
- «сервер оператора скомпрометирован» — при таком доступе защищать уже нечего.

---

## Если Подозреваешь Компрометацию

Порядок важен: сначала обрубается доступ к аккаунту MAX, потом к боту.

1. **Отвяжи устройство MAX.** На телефоне: **MAX → Настройки → Устройства** → найди
   сессию сервера и **заверши** её. Это обесценивает и `data/chrome-profile`, и любой
   утёкший QR.
2. **Отзови токен бота.** В [@BotFather](https://t.me/BotFather): `/mybots` → твой бот →
   **API Token** → **Revoke current token**. Старый токен перестаёт работать мгновенно.
3. **Останови мост:** `docker compose down` в каталоге проекта.
4. **Вычисти состояние:** удали `data/chrome-profile/` (сессия MAX) и
   `logs/diagnostics/` (дампы и скриншоты переписки). `data/max-in-tg.sqlite` содержит
   привязки «чат MAX → тема Telegram» — удалять его не обязательно, но он тоже содержит
   переписку.
5. **Пропиши новый токен** в `.env` и подними мост:
   `docker compose up -d --force-recreate` (именно recreate — `restart` не перечитывает
   `.env`). Бот пришлёт новый QR, вход делается заново.
6. Если утекал ещё и доступ к серверу — смени ключи SSH и считай скомпрометированным
   всё, что лежало в `data/` и `.env`.

Профилактика: держи `.env` c правами `600`, не выкладывай скриншоты Telegram-чата с QR,
вызывай `/diagnostics` только из личного чата и удаляй присланные файлы после отладки,
не переиспользуй бота для чего-то ещё.

---

## English Summary

This bridge holds a **live MAX messenger session** (`data/chrome-profile`), a **Telegram
bot token** (`.env`) and a **SQLite database of real conversations** — including messages
from people who never agreed to the bridge existing.

**Reporting:** do not open a public issue. Use the repository's **Security → Report a
vulnerability** tab (GitHub Private Vulnerability Reporting). Include impact, repro steps
and the commit SHA; never attach real tokens, QR codes, profile data or unredacted
`/diagnostics` dumps.

**Scope:** a single-user, self-hosted bridge — no multi-tenancy, and the operator is
assumed to trust their own server. In scope: owner-check bypass, leakage of the QR/token/
Chrome profile, messages routed to the wrong MAX chat or Telegram topic, path traversal,
container escape, RCE via media handling. Out of scope: MAX Web DOM changes that break
selectors, MAX ToS questions, the documented fact that `/diagnostics` screenshots show the
open conversation, and vulnerabilities in MAX/Telegram/Docker themselves.

**No bounty. Best-effort response. Personal project.**

**Suspected compromise:** (1) revoke the linked device in **MAX → Settings → Devices**;
(2) revoke the bot token in [@BotFather](https://t.me/BotFather) → `/mybots` → **API
Token** → **Revoke current token**; (3) `docker compose down`; (4) delete
`data/chrome-profile/` and `logs/diagnostics/`; (5) put the new token into `.env` and run
`docker compose up -d --force-recreate`, then sign in again with the fresh QR.
