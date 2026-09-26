// A fake MAX Web page for the browser tests (tests/browser). Its markup
// follows the templates in MAX Web's own bundle (web.max.ru):
//   message:  <div data-bubbles-variant> <div class="bordersWrapper"> <div class="bubble"> <div class="bubbleContent">…
//   sender (groups, first bubble of a run): .bubbleContent > <div class="header"><button class="header"><span class="name"><span class="name"><span class="text">
//   time:     .bubbleContent > <span class="meta"><div class="meta meta--text"><span class="text"> 12:04 </span> — there is no .time[aria-label] in a bubble
//   file:     .bubbleContent > <div class="attaches"><button class="container" aria-label="Скачать"> .title (name) .info ("Скачать • 1.23 MB");
//             a click makes a temporary <a href download=name> and clicks it (MAX asks its API for the URL first)
//   links:    <a class="link" href> in the text; a preview card: .bubbleContent > <div class="share"><a class="container" href> [picture] .host .title .description
//   search (aside .search input.field, placeholder «Найти»): while it has a query the chat list gives way to
//             .searchResultsList — own chats first, then <span class="separator">Глобальный поиск</span> (a moment later),
//             <span class="separator">Сообщения</span>; for a whole phone number first «Действия» / «Найти по номеру»,
//             which opens that person's chat and switches the list to MAX's contacts (a.cell links) — back through
//             nav «Папки и профиль» [aria-labelledby$=-all-folder-title]; an unknown number opens «Не нашли номер …»
//   a chat opens by its address too: MAX's router takes over a click on <a href="/<id>">
//   text:     <span class="text"> with emoji as <span class="emoji"><img alt></span>
//             and animoji as <span class="animoji" data-lexical-animoji-emoji><img class="img" src="data:…" alt>…
//   emoji-only message: <div class="emojis"> with big emoji (plain img, or a lottie player)
//   reactions (text bubbles): next sibling of the bubble's wrapper: <div class="reactions"><div class="reactions"><button class="reaction [reaction--active]"><div class="animoji">lottie</div> <span class="counter">N</span></button>
//   reactions (media bubbles): inside .bubbleContent: <div class="reactions reactions--inside">…
//   message menu (contextmenu or "Message actions"): <div role="menu"><div class="menuContainer"><div class="reactionsSlot"><div class="wrapper"><div class="reactions"><button class="reaction"><div class="animoji">lottie</div></button>… <button class="extendBtn">
// Lottie players fetch(url, {mode:'cors'}) and show the placeholder <span class="emoji"><img alt></span>
// until the JSON arrives (then a canvas), or forever when the body is empty — like MAX's $5 player.
import http from 'node:http';

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const LOTTIE = JSON.stringify({ v: '5.7.0', fr: 30, ip: 0, op: 30, w: 100, h: 100, layers: [{ ty: 4, nm: 'x' }], assets: [] });

export const PAGE = (opts = {}) => `<!doctype html><html><head><meta charset="utf-8"><title>MAX</title>
<style>
 body{margin:0;font:14px sans-serif;display:flex;height:100vh}
 aside{width:300px;height:100vh}
 aside .scrollable{height:900px;overflow:auto;position:relative}
 aside .item{height:72px}
 aside .results:empty{display:none}
 dialog{position:fixed;top:40%;left:40%}
 main{flex:1;display:flex;flex-direction:column;height:100vh}
 main .scrollable{flex:1;overflow:auto}
 .row{padding:6px 12px;position:relative}
 .bubble{display:inline-block;max-width:600px;background:#eef;padding:8px;border-radius:8px}
 .reactions{display:flex;gap:4px;margin-top:2px}
 .reaction{display:inline-flex;align-items:center;gap:2px;height:28px;min-width:40px}
 .emoji img{width:20px;height:20px}
 .emojis .emoji img{width:64px;height:64px}
 canvas{width:20px;height:20px}
 .emojis canvas{width:64px;height:64px}
 [role=menu]{position:fixed;background:#fff;border:1px solid #999;padding:6px;z-index:10}
 .toolbar{position:absolute;right:20px;top:0;display:none}
 .row:hover .toolbar{display:block}
 [data-testid=composer]{height:60px}
</style></head><body>
<nav aria-label="Папки и профиль"><div class="navigation"><div><div class="foldersViewport"><div class="item"><button id="all-chats" aria-labelledby="nav-all-folder-title nav-all-folder-counter"><span id="nav-all-folder-title">Все</span></button></div></div></div></div></nav>
<aside aria-labelledby="aside-header-title"><h1 id="aside-header-title">Chats</h1>
 <div class="search"><div class="input"><input class="field" type="text" placeholder="Найти"></div><div class="clear"></div></div>
 <div class="scrollable"><div class="scrollListContent"></div></div>
 <div class="results"></div></aside>
<main><h2 id="main-header-title" class="sr-only"></h2><div class="header"><span class="title"></span></div>
 <div class="scrollable" id="scroller"><div class="scrollListContent" id="msgs"></div></div>
 <div data-testid="composer"><button aria-label="Upload file">+</button><div contenteditable="true" role="textbox" id="composer"></div><button aria-label="Send message" id="send">send</button></div>
</main>
<script>
const opts = ${JSON.stringify(opts)};
window.__escapeClosedChat = 0;
window.__chats = opts.chats;
window.__active = null;
window.__directory = opts.directory || [];
window.__tab = 'chats';
const AVAILABLE = opts.available || ['👍', '❤️', '😂', '🔥', '😮', '😢', '🙏', '👎', '🎉'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cp = (e) => [...e].map((c) => c.codePointAt(0).toString(16)).filter((h) => h !== 'fe0f').join('-');
const emojiImg = (e, size) => '<span class="emoji"><img src="/e/' + cp(e) + '.png" alt="' + esc(e) + '" width="' + (size || 20) + '"></span>';
// A lottie player: placeholder now, canvas once its JSON arrives (never, if the body is empty).
const lottie = (e, url) => '<div class="lottie" data-url="' + esc(url || '/animoji/' + cp(e) + '.json') + '" data-emoji="' + esc(e) + '">' + emojiImg(e) + '</div>';
const renderText = (parts) => parts.map((p) => typeof p === 'string' ? esc(p)
  : p.link ? '<a class="link" href="' + esc(p.link) + '">' + esc(p.link) + '</a>'
  : p.emoji ? emojiImg(p.emoji)
  : p.animoji ? '<span class="animoji" data-lexical-animoji="" data-lexical-animoji-emoji="' + esc(p.animoji) + '"><img class="img" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" alt="' + esc(p.animoji) + '"><span class="player">' + lottie(p.animoji) + '</span></span>'
  : '').join('');
const chips = (m) => (m.reactions || []).filter((r) => r.count > 0).map((r) => '<button class="reaction' + (m.mine === r.emoji ? ' reaction--active' : '') + '" data-mid="' + m.id + '" data-emoji="' + esc(r.emoji) + '"><div class="animoji">' + lottie(r.emoji) + '</div> <span class="counter">' + r.count + '</span></button>').join('');
// .block > .messageWrapper > .message > .message > [data-bubbles-variant] >
// .bordersWrapper > .bubble > .bubbleContent; the reactions of a text bubble
// come right after .bordersWrapper.
function renderMessage(m) {
  const inside = m.media || m.sticker;
  let content = '';
  if (m.author) content += '<div class="header"><button class="header"><span class="name"><span class="name"><span class="text">' + esc(m.author) + '</span></span></span>'
    + (m.role ? ' <span class="role"><span class="text">' + esc(m.role) + '</span></span>' : '') + '</button></div>';
  if (m.media) content += '<div class="media"><img src="' + m.media + '" width="300" height="200"></div>';
  if (m.file) content += '<div class="attaches"><button class="container" aria-label="Скачать" data-mid="' + m.id + '"' + (m.file.deleted ? ' disabled' : '') + '>'
    + (m.file.preview ? '<div class="fileIcon preview"><img src="' + m.file.preview + '" alt="' + esc(m.file.name) + '"></div>' : '<div class="fileIcon"><svg></svg></div>')
    + '<div class="title">' + esc(m.file.name) + '</div><div class="info">' + (m.file.deleted ? 'Файл удален' : 'Скачать • ' + esc(m.file.size)) + '</div></button></div>';
  if (m.sticker) content += '<div class="sticker">' + '<div class="lottie" data-url="' + m.sticker + '" data-emoji="sticker"><img src="/e/stk.png" alt="" width="170"></div></div>';
  if (m.big) content += '<div class="emojis">' + m.big.map((b) => b.plain ? emojiImg(b.plain, 64) : lottie(b.anim)).join('') + '</div>';
  if (m.location) content += '<div class="location"><div class="map"></div></div>';
  if (m.text) content += '<span class="text">' + renderText(m.text) + '</span>';
  if (m.share) content += '<div class="share"><a class="container" href="' + esc(m.share.url) + '" rel="noopener noreferrer">'
    + (m.share.image ? '<div class="media"><img src="' + m.share.image + '" width="300" height="150"></div>' : '')
    + '<div class="content"><span class="host">' + esc(new URL(m.share.url).host) + '</span> <span class="title">' + esc(m.share.title || 'Title') + '</span> <span class="description">…</span></div></a></div>';
  if (inside && (m.reactions || []).some((r) => r.count > 0)) content += '<div class="reactions reactions--inside"><div class="reactions reactions--inside">' + chips(m) + '</div></div>';
  content += '<span class="meta"><div class="meta meta--text"><span class="text"> ' + m.time + (m.edited ? ' ред.' : '') + ' </span></div></span>';
  const reactions = !inside && (m.reactions || []).some((r) => r.count > 0) ? '<div class="reactions"><div class="reactions">' + chips(m) + '</div></div>' : '';
  return '<div class="row block" role="listitem" data-mid="' + m.id + '"><div class="messageWrapper' + (m.out ? ' messageWrapper--isOut' : '') + '"><div class="message"><div class="message">'
    + '<div data-bubbles-variant="' + (m.out ? 'outgoing' : 'incoming') + '"><div class="bordersWrapper"><div class="bubble"><div class="bubbleContent">' + content + '</div></div></div>' + reactions + '</div>'
    + '</div></div><div class="toolbar"><button aria-label="Reply">↩</button><button aria-label="Message actions" data-mid="' + m.id + '">⋯</button></div></div></div>';
}
function loadLotties(root) {
  root.querySelectorAll('.lottie:not([data-started])').forEach((el) => {
    el.setAttribute('data-started', '1');
    fetch(el.getAttribute('data-url'), { mode: 'cors' }).then((r) => r.text()).then((text) => {
      if (!text) return; // placeholder stays
      const c = document.createElement('canvas');
      c.width = el.closest('.emojis') || el.closest('.sticker') ? 128 : 20; c.height = c.width;
      el.textContent = ''; el.appendChild(c);
    }).catch(() => {});
  });
}
window.renderMessages = function renderMessages() {
  const chat = window.__chats.find((c) => c.title === window.__active);
  const box = document.getElementById('msgs');
  box.innerHTML = chat ? chat.messages.map(renderMessage).join('') : '';
  loadLotties(box);
};
// A chat list item shows "печатает…" in place of its last message: <span class="text"><span class="typing"><span class="text"></span> [lottie] label
window.openChat = function openChat(opened) {
  window.__active = opened.title;
  // Like MAX: the address names the open chat (/<id>).
  if (opened.maxId) history.pushState({}, '', '/web.max.ru/' + opened.maxId);
  document.getElementById('main-header-title').textContent = 'Окно чата с ' + window.__active;
  document.querySelector('main .header .title').textContent = window.__active;
  window.renderMessages();
  // MAX clears its search when a chat opens.
  window.setSearch('');
};
window.renderChats = function renderChats() {
  const list = document.querySelector('aside .scrollListContent');
  if (window.__tab === 'contacts') {
    const people = window.__chats.concat(window.__directory).filter((c) => c.maxId);
    list.innerHTML = people.map((c, i) => '<div class="item" data-index="' + i + '"><div class="wrapper"><a class="cell" href="/' + c.maxId + '"><span class="title">' + esc(c.title) + '</span><span class="description">в сети</span></a></div></div>').join('');
    return;
  }
  list.innerHTML = window.__chats.map((c, i) => '<div class="item" data-index="' + i + '"><button class="cell"><h3 class="title"><span class="name"><span class="text">' + esc(c.title) + '</span></span></h3>'
    + '<span class="text">' + (c.typing ? '<span class="typing"><span class="text"></span> <span class="lottie"></span> ' + esc(c.typing) + '</span>' : esc(c.preview || '')) + '</span>'
    + '</button></div>').join('');
  list.querySelectorAll('.item').forEach((item) => item.querySelector('button').addEventListener('click', () => {
    window.openChat(window.__chats[Number(item.getAttribute('data-index'))]);
  }));
};
const phoneOf = (value) => {
  if (!/^[+8][\\d\\s()-]+$/.test(value)) return null;
  let digits = value.replace(/[^\\d+]/g, '');
  if (digits.startsWith('8')) digits = '+7' + digits.slice(1);
  return digits.length === 12 ? digits : null;
};
const resultItem = (title, attrs, text) => '<button class="item" ' + attrs + '><div class="cell"><div class="image"></div><span class="title"><span class="title"><span class="name"><span class="text">' + esc(title) + '</span></span></span></span><span class="text">' + esc(text || '') + '</span><div class="meta"></div></div></button>';
let searchTimer = null;
window.setSearch = function setSearch(value) {
  const input = document.querySelector('aside .search input.field');
  if (input.value !== value) input.value = value;
  const results = document.querySelector('aside .results');
  const scrollable = document.querySelector('aside .scrollable');
  const clear = document.querySelector('aside .search .clear');
  clearTimeout(searchTimer);
  if (!value) {
    results.innerHTML = '';
    scrollable.style.display = '';
    clear.innerHTML = '';
    return;
  }
  clear.innerHTML = '<button aria-label="Очистить">×</button>';
  scrollable.style.display = 'none';
  const q = value.toLowerCase();
  const phone = phoneOf(value);
  const own = window.__chats.filter((c) => c.title.toLowerCase().includes(q));
  const messages = [];
  for (const c of window.__chats) for (const m of c.messages) if ((m.text || []).some((p) => typeof p === 'string' && p.toLowerCase().includes(q))) messages.push(c);
  const render = (withGlobal) => {
    const global = withGlobal ? window.__directory.filter((p) => p.title.toLowerCase().includes(q)) : [];
    let html = '';
    if (phone) html += '<span class="separator">Действия</span><button class="item" data-phone="' + phone + '">Найти по номеру</button>';
    html += own.map((c) => resultItem(c.title, 'data-open-title="' + esc(c.title) + '"', c.preview)).join('');
    if (global.length) html += '<span class="separator">Глобальный поиск</span>' + global.map((p) => resultItem(p.title, 'data-open-directory="' + esc(p.maxId) + '"', p.hint)).join('');
    if (messages.length) html += '<span class="separator">Сообщения</span>' + messages.map((c) => resultItem(c.title, 'data-message-of="' + esc(c.title) + '"', value)).join('');
    if (!html) html = '<div class="empty">Ничего не нашли</div>';
    results.innerHTML = '<div class="content searchResultsList">' + html + '</div>';
  };
  render(false);
  // Global results come from MAX's server a moment later.
  searchTimer = setTimeout(() => render(true), 300);
};
const findMsg = (id) => { for (const c of window.__chats) for (const m of c.messages) if (m.id === id) return m; return null; };
function setReaction(m, emoji) {
  m.reactions = m.reactions || [];
  if (m.mine) { const old = m.reactions.find((r) => r.emoji === m.mine); if (old) old.count -= 1; }
  if (emoji && emoji !== m.mine) {
    const r = m.reactions.find((x) => x.emoji === emoji);
    if (r) r.count += 1; else m.reactions.push({ emoji, count: 1 });
    m.mine = emoji;
  } else m.mine = null;
  m.reactions = m.reactions.filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
  window.__log = (window.__log || []).concat([{ id: m.id, set: m.mine }]);
  window.renderMessages();
}
let menu = null;
function closeMenu() { if (menu) { menu.remove(); menu = null; } }
function openMenu(m, x, y, extended) {
  closeMenu();
  const list = extended ? AVAILABLE : AVAILABLE.slice(0, AVAILABLE.length > 8 ? 7 : 8);
  menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.innerHTML = '<div class="menuContainer"><div class="reactionsSlot"><div class="wrapper"><div class="reactions' + (extended ? ' reactions--extended' : '') + '">'
    + list.map((e) => '<button class="reaction' + (m.mine === e ? ' reaction--active' : '') + '" data-pick="' + esc(e) + '"><div class="animoji">' + lottie(e) + '</div></button>').join('')
    + (!extended && AVAILABLE.length > 8 ? '<button class="extendBtn">▾</button>' : '') + '</div></div></div><div class="item">Ответить</div></div>';
  document.body.appendChild(menu);
  loadLotties(menu);
  menu.addEventListener('click', (ev) => {
    const pick = ev.target.closest('[data-pick]');
    if (pick) { const e = pick.getAttribute('data-pick'); setReaction(m, m.mine === e ? null : e); closeMenu(); return; }
    if (ev.target.closest('.extendBtn')) openMenu(m, x, y, true);
  });
}
document.addEventListener('contextmenu', (ev) => {
  const row = ev.target.closest('.row');
  if (!row || opts.noContextMenu) return;
  ev.preventDefault();
  openMenu(findMsg(row.getAttribute('data-mid')), ev.clientX, ev.clientY, false);
});
document.querySelector('aside .search input.field').addEventListener('input', (ev) => window.setSearch(ev.target.value));
// MAX's router takes over clicks on its own links: /<id> opens that chat.
document.addEventListener('click', (ev) => {
  const link = ev.target.closest('a[href]');
  if (!link || link.hasAttribute('download')) return;
  const id = (link.getAttribute('href') || '').split('/').pop();
  const found = window.__chats.concat(window.__directory).find((c) => c.maxId === id);
  if (found) {
    ev.preventDefault();
    window.__openedByAddress = (window.__openedByAddress || []).concat([id]);
    window.openChat(found);
  }
}, true);
document.addEventListener('click', (ev) => {
  if (ev.target.closest('aside .search .clear button')) { window.setSearch(''); return; }
  if (ev.target.closest('#all-chats')) { window.__tab = 'chats'; window.renderChats(); return; }
  const result = ev.target.closest('.searchResultsList button.item');
  if (result) {
    const title = result.getAttribute('data-open-title');
    const person = result.getAttribute('data-open-directory');
    const phone = result.getAttribute('data-phone');
    if (title) window.openChat(window.__chats.find((c) => c.title === title));
    else if (person) window.openChat(window.__directory.find((p) => p.maxId === person));
    else if (phone) {
      const found = window.__directory.concat(window.__chats).find((p) => p.phone === phone);
      if (!found) {
        const modal = document.createElement('dialog');
        modal.setAttribute('data-testid', 'modal');
        modal.setAttribute('open', '');
        modal.innerHTML = '<h2 id="modalHeaderTitle">Не нашли номер ' + esc(phone) + '</h2>';
        document.body.appendChild(modal);
        return;
      }
      window.openChat(found);
      window.__tab = 'contacts';
      window.renderChats();
    }
    return;
  }
  const file = ev.target.closest('.attaches button.container[data-mid]');
  if (file && !file.disabled) {
    const name = findMsg(file.getAttribute('data-mid')).file.name;
    window.__downloads = (window.__downloads || []).concat([name]);
    window.__clickedFiles = (window.__clickedFiles || []).concat([file.getAttribute('data-mid')]);
    const a = document.createElement('a');
    a.href = '/files/' + encodeURIComponent(name);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    return;
  }
  const chip = ev.target.closest('button.reaction[data-mid]');
  if (chip) { const m = findMsg(chip.getAttribute('data-mid')); const e = chip.getAttribute('data-emoji'); setReaction(m, m.mine === e ? null : e); return; }
  const actions = ev.target.closest('button[aria-label="Message actions"]');
  if (actions) { const r = actions.getBoundingClientRect(); openMenu(findMsg(actions.getAttribute('data-mid')), r.x, r.y + 20, false); return; }
  if (menu && !ev.target.closest('[role=menu]')) closeMenu();
});
// Like MAX: an open popover eats Escape (capture phase); otherwise Escape closes the chat.
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && menu) { ev.preventDefault(); ev.stopPropagation(); closeMenu(); } }, { capture: true });
window.addEventListener('keydown', (ev) => {
  const modal = document.querySelector('dialog[data-testid="modal"][open]');
  if (ev.key === 'Escape' && modal) { ev.preventDefault(); ev.stopPropagation(); modal.remove(); }
}, { capture: true });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { window.__escapeClosedChat += 1; document.getElementById('main-header-title').textContent = ''; window.__active = null; window.renderMessages(); } });
document.getElementById('send').addEventListener('click', () => {
  const ed = document.getElementById('composer');
  const text = ed.textContent;
  if (!text.trim()) return;
  const chat = window.__chats.find((c) => c.title === window.__active);
  const person = window.__directory.find((p) => p.title === window.__active);
  if (person && person.restricted) {
    // Someone who takes messages only from their contacts: MAX refuses.
    ed.textContent = '';
    const modal = document.createElement('dialog');
    modal.setAttribute('data-testid', 'modal');
    modal.setAttribute('open', '');
    modal.innerHTML = '<h2 id="modalHeaderTitle">Хотите написать первым?</h2>';
    document.body.appendChild(modal);
    return;
  }
  window.__sent = (window.__sent || []).concat([{ chat: window.__active, text }]);
  if (chat) chat.messages.push({ id: 's' + window.__sent.length, time: '23:59', out: true, text: [text] });
  ed.textContent = '';
  window.renderMessages();
});
renderChats();
</script></body></html>`;

export const serve = (pageOpts) => new Promise((resolve) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push(u.pathname + u.search);
    if (u.pathname.startsWith('/e/')) { res.setHeader('content-type', 'image/png'); return res.end(PNG_1PX); }
    if (u.pathname.startsWith('/animoji/') || u.pathname.startsWith('/sticker/')) {
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      return res.end(LOTTIE);
    }
    if (u.pathname.startsWith('/photo/')) { res.setHeader('content-type', 'image/png'); return res.end(PNG_1PX); }
    if (u.pathname.startsWith('/files/')) {
      // A file's bytes name it, so a test can tell which one was fetched.
      const name = decodeURIComponent(u.pathname.slice('/files/'.length));
      res.setHeader('content-type', 'application/octet-stream');
      return res.end(Buffer.concat([Buffer.from(`FILE:${name}\n`), Buffer.alloc(4096, 0x20)]));
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE(typeof pageOpts === 'function' ? pageOpts() : pageOpts));
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/web.max.ru/` }));
});
