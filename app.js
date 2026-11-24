/* =============================================================================
   스크랩박스 — app.js
   Part 1 / 순수 로직: DOM 없이도 돌아가고 테스트할 수 있는 부분.
   (파서 · 필터 · 포맷 · 카드 렌더 · 백업 검증)
   ============================================================================= */

'use strict';

var APP_ID = 'scrap-box';
var BACKUP_VERSION = 1;

/* 화면 껍데기(index.html)와 스크립트·스타일 버전이 어긋나면(서비스워커 캐시 등)
   섞인 화면이 뜬다. index.html이 이 값을 보고 버전을 맞추며, 다를 때는 캐시를 비우고
   한 번만 새로 불러온다(자가 복구). 버전을 올릴 때는 SHELL_VERSION과 index.html의
   data-shell·?v= 값·sw.js의 CACHE/SHELL을 함께 올린다. */
var SHELL_VERSION = '4';
if (typeof window !== 'undefined') window.SCRAPBOX_SHELL_VERSION = SHELL_VERSION;

var TYPE_LABEL = { link: '링크', image: '이미지', memo: '메모' };
var TYPE_EMOJI = { link: '🔗', image: '🖼️', memo: '📝' };

var DEFAULT_FOLDERS = [
  { id: 'inbox', name: '미분류', emoji: '📥', color: '#948C80', order: 0, system: true },
  { id: 'shopping', name: '쇼핑/위시', emoji: '🛍️', color: '#FF5A8A', order: 1 },
  { id: 'recipe', name: '레시피/맛집', emoji: '🍜', color: '#FF9A3C', order: 2 },
  { id: 'reference', name: '참고자료', emoji: '📚', color: '#4A8BFF', order: 3 },
  { id: 'daily', name: '일상메모', emoji: '📝', color: '#17A06A', order: 4 }
];

var EMOJI_CHOICES = [
  '📥', '🛍️', '🍜', '📚', '📝', '⭐', '💡', '🏠',
  '✈️', '🎬', '🎵', '💪', '💰', '🎁', '📷', '🧾',
  '🩺', '🌱', '🚗', '👗', '🧸', '🍰', '☕', '🗂️'
];
var COLOR_CHOICES = [
  '#F0472B', '#FF5A8A', '#FF9A3C', '#E5B100', '#17A06A',
  '#0EA5A5', '#4A8BFF', '#7C5CFF', '#B054C8', '#948C80'
];

var MAX_TAGS = 12;
var MAX_IMAGE_WIDTH = 1400;
var MAX_THUMB_WIDTH = 640;

/* ---------------------------------------------------------------- utilities */

function num(v, dflt) {
  var n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : (dflt || 0);
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function uid(prefix) {
  var p = prefix || 'it';
  return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
}

function oneLine(text, max) {
  var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max - 1).replace(/[\s,.;:!?]+$/, '') + '…';
  return s;
}

function truncate(text, max) {
  var s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/* ------------------------------------------------------------- url handling */

var BAD_SCHEME = /^(javascript|data|vbscript|file|blob|about|chrome|itms-apps):/i;
var HAS_SCHEME = /^[a-z][a-z0-9+.\-]*:\/\//i;
var SCHEME_ONLY = /^[a-z][a-z0-9+.\-]*:/i;
var HOST_LIKE = /^([\w\u00a1-\uffff-]+\.)+[a-z\u00a1-\uffff]{2,}(:\d{2,5})?([/?#].*)?$/i;

function looksLikeHost(s) { return HOST_LIKE.test(s); }

/**
 * 사용자가 붙여넣은 문자열을 안전한 http(s) URL로 정리한다.
 * @returns {{ok:boolean, url:string, domain:string, reason:string}}
 */
function normalizeUrl(raw) {
  var fail = function (reason) { return { ok: false, url: '', domain: '', reason: reason }; };
  if (typeof raw !== 'string') return fail('type');
  var s = raw.trim();
  if (!s) return fail('empty');

  // 따옴표·괄호·마침표 같은 감싸는 문자 제거
  s = s.replace(/^[\s<("'\[\{]+/, '').replace(/[\s>)"'\]\}.!,;]+$/, '');
  if (!s) return fail('empty');
  if (BAD_SCHEME.test(s)) return fail('scheme');
  if (/\s/.test(s)) {
    // 문장 속 주소가 아니라 띄어쓰기 있는 덩어리면 첫 토큰만 시도
    var first = s.split(/\s+/)[0];
    if (first && looksLikeHost(first.replace(/^https?:\/\//i, ''))) s = first;
    else return fail('space');
  }

  var href = s;
  if (!HAS_SCHEME.test(s)) {
    if (SCHEME_ONLY.test(s)) return fail('scheme');
    if (!looksLikeHost(s)) return fail('host');
    href = 'https://' + s;
  }

  var u;
  try { u = new URL(href); } catch (e) { return fail('parse'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('scheme');
  if (!u.hostname || (u.hostname.indexOf('.') === -1 && u.hostname !== 'localhost')) return fail('host');

  // 의미 없는 트래킹 파라미터 정리
  try {
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'igshid', 'si']
      .forEach(function (k) { u.searchParams.delete(k); });
  } catch (e) { /* noop */ }

  var path = u.pathname === '/' ? '/' : u.pathname;
  var out = u.origin + (path === '/' ? '' : path) + (u.search || '') + (u.hash || '');

  return { ok: true, url: out, domain: u.hostname.replace(/^www\./i, ''), reason: '' };
}

function domainOf(url) {
  if (!url) return '';
  try {
    var u = new URL(String(url));
    return u.hostname.replace(/^www\./i, '');
  } catch (e) {
    var m = String(url).match(/^(?:https?:\/\/)?([^/?#:]+)/i);
    return m ? m[1].replace(/^www\./i, '') : '';
  }
}

function findUrl(text) {
  if (!text) return null;
  var s = String(text);
  var m = s.match(/https?:\/\/[^\s<>"')\]]+/i);
  if (!m) {
    m = s.match(/(?:^|[\s(<\[])((?:www\.)?(?:[a-z0-9\u00a1-\uffff-]+\.)+[a-z\u00a1-\uffff]{2,}(?:\/[^\s<>"')\]]*)?)/i);
    if (m) m = [m[1]];
  }
  if (!m) return null;
  var raw = m[0].replace(/[.,;:!?)\]}'"]+$/, '');
  var n = normalizeUrl(raw);
  return n.ok ? { url: n.url, domain: n.domain, raw: raw } : null;
}

function detectType(text) {
  return findUrl(text) ? 'link' : 'memo';
}

/* ---------------------------------------------------------- query / tags */

/**
 * iOS 단축어·공유에서 넘어오는 ?url= / ?text= / ?title= / ?folder= 를 해석한다.
 * @returns {null|{type:string, url:string, title:string, memo:string, folder:string}}
 */
function parseQueryParams(search) {
  var q = String(search == null ? '' : search).replace(/^\?/, '').trim();
  if (!q) return null;

  var params;
  try { params = new URLSearchParams(q); } catch (e) { return null; }

  var rawUrl = params.get('url') || params.get('u') || '';
  var rawText = params.get('text') || params.get('t') || params.get('body') || params.get('memo') || '';
  var title = (params.get('title') || params.get('name') || '').trim();
  var folder = (params.get('folder') || params.get('f') || '').trim();
  var typeHint = (params.get('type') || '').toLowerCase();

  if (!rawUrl && !rawText && !title) return null;

  var out = { type: 'link', url: '', title: title, memo: '', folder: folder };

  if (rawUrl) {
    var n = normalizeUrl(rawUrl);
    if (n.ok) { out.url = n.url; out.type = 'link'; }
  }

  if (rawText) {
    var found = out.url ? null : findUrl(rawText);
    if (found) {
      out.url = found.url;
      out.type = 'link';
      var rest = String(rawText).replace(found.raw, ' ').replace(/\s+/g, ' ').trim();
      if (rest) out.memo = rest;
    } else if (!out.url) {
      out.type = 'memo';
      out.memo = String(rawText).trim();
    } else if (rawText.trim() && rawText.trim() !== out.url) {
      out.memo = String(rawText).replace(rawUrl, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  if (typeHint === 'memo' && !out.url) out.type = 'memo';
  if (typeHint === 'image') out.type = 'image';
  if (!out.url && out.type === 'link' && !out.memo) out.type = 'memo';

  return out;
}

function normalizeTags(list) {
  var out = [];
  var src = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[\s,]+/);
  src.forEach(function (tok) {
    var t = String(tok == null ? '' : tok).replace(/^#+/, '').replace(/[#,]+$/g, '').trim();
    if (!t) return;
    if (t.length > 24) t = t.slice(0, 24);
    var dup = out.some(function (x) { return x.toLowerCase() === t.toLowerCase(); });
    if (!dup) out.push(t);
  });
  return out.slice(0, MAX_TAGS);
}

function extractTags(input) { return normalizeTags(input); }

function tagsToText(tags) {
  return (tags || []).map(function (t) { return '#' + t; }).join(' ');
}

/* ------------------------------------------------------------ date format */

function humanDate(ts, now) {
  var t = num(ts, 0);
  if (!t) return '';
  var n = now || Date.now();
  var diff = n - t;
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;
  if (diff < MIN) return '방금';
  if (diff < HOUR) return Math.floor(diff / MIN) + '분 전';

  var d1 = new Date(t), d2 = new Date(n);
  var sameDay = d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
  if (sameDay) return Math.floor(diff / HOUR) + '시간 전';

  var y = new Date(n - DAY);
  var isYest = d1.getFullYear() === y.getFullYear() && d1.getMonth() === y.getMonth() && d1.getDate() === y.getDate();
  if (isYest) return '어제';
  if (d1.getFullYear() === d2.getFullYear()) return (d1.getMonth() + 1) + '월 ' + d1.getDate() + '일';
  return d1.getFullYear() + '. ' + (d1.getMonth() + 1) + '. ' + d1.getDate() + '.';
}

function fullDate(ts) {
  var d = new Date(num(ts, 0));
  if (!d.getTime()) return '';
  var h = d.getHours();
  var ap = h < 12 ? '오전' : '오후';
  var hh = h % 12 === 0 ? 12 : h % 12;
  var mm = String(d.getMinutes());
  if (mm.length < 2) mm = '0' + mm;
  return d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + '. ' + ap + ' ' + hh + ':' + mm;
}

function isoDate(ts) {
  try { return new Date(num(ts, Date.now())).toISOString(); } catch (e) { return ''; }
}

/* --------------------------------------------------------------- item text */

function fallbackTitle(item) {
  if (!item) return '스크랩';
  if (item.type === 'link') {
    var d = item.domain || domainOf(item.url);
    if (item.url) {
      try {
        var u = new URL(item.url);
        var seg = decodeURIComponent(u.pathname).replace(/\/+$/, '').split('/').pop() || '';
        seg = seg.replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]{2,4}$/i, '').trim();
        if (seg && seg.length > 1 && !/^\d+$/.test(seg)) return truncate(seg, 70);
      } catch (e) { /* noop */ }
    }
    return d || '링크';
  }
  if (item.type === 'image') {
    var imgLine = String(item.memo || '').split('\n')[0].trim();
    if (imgLine) return oneLine(imgLine, 40);
    if ((item.tags || []).length) return '#' + item.tags[0];
    return '이미지';
  }
  var firstLine = String(item.memo || '').split('\n')[0].trim();
  return oneLine(firstLine, 40) || '메모';
}

function itemTitle(item) {
  return oneLine(item && item.title, 200) || fallbackTitle(item);
}

/* ------------------------------------------------------------------ filter */

function itemHaystack(item) {
  if (item.__hay) return item.__hay;
  var parts = [
    item.title, item.url, item.memo, item.domain, item.description, item.siteName,
    (item.tags || []).map(function (t) { return '#' + t; }).join(' ')
  ];
  var hay = parts.filter(Boolean).join(' ').toLowerCase();
  try { Object.defineProperty(item, '__hay', { value: hay, enumerable: false, configurable: true }); } catch (e) { /* noop */ }
  return hay;
}

function matchesTerm(item, term) {
  if (!term) return true;
  var hay = itemHaystack(item);
  if (term.charAt(0) === '#') {
    var tag = term.slice(1).toLowerCase();
    return (item.tags || []).some(function (t) { return t.toLowerCase() === tag; }) || hay.indexOf(term) !== -1;
  }
  return hay.indexOf(term) !== -1;
}

function inFolder(item, folderId) {
  if (!folderId || folderId === 'all') return true;
  if (folderId === 'fav') return !!item.favorite;
  return (item.folderId || 'inbox') === folderId;
}

function sortItems(list) {
  return list.slice().sort(function (a, b) {
    if (!!b.favorite !== !!a.favorite) return b.favorite ? 1 : -1;
    var ac = num(a.createdAt, 0), bc = num(b.createdAt, 0);
    if (bc !== ac) return bc - ac;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * @param {Array} items
 * @param {{folderId?:string, query?:string, type?:string}} opts
 */
function filterItems(items, opts) {
  var o = opts || {};
  var folderId = o.folderId || 'all';
  var type = o.type || 'all';
  var list = (items || []).filter(function (it) {
    if (!it) return false;
    if (!inFolder(it, folderId)) return false;
    if (type !== 'all' && it.type !== type) return false;
    return true;
  });

  var q = String(o.query == null ? '' : o.query).trim().toLowerCase();
  if (q) {
    var terms = q.split(/\s+/).filter(Boolean);
    list = list.filter(function (it) {
      return terms.every(function (t) { return matchesTerm(it, t); });
    });
  }
  return sortItems(list);
}

function countByFolder(items) {
  var counts = { all: 0, fav: 0 };
  (items || []).forEach(function (it) {
    if (!it) return;
    counts.all++;
    if (it.favorite) counts.fav++;
    var f = it.folderId || 'inbox';
    counts[f] = (counts[f] || 0) + 1;
  });
  return counts;
}

/* ------------------------------------------------------------ list sharing */

/**
 * 카카오톡 등에 붙여넣기 좋은 텍스트 묶음.
 */
function formatBundle(items, folderName) {
  var list = (items || []).filter(Boolean);
  if (!list.length) return '';
  var head = folderName ? '📌 ' + folderName + ' (' + list.length + ')' : '📌 스크랩 ' + list.length + '개';
  var blocks = [head, ''];

  list.forEach(function (it, i) {
    var lines = [];
    lines.push((i + 1) + '. ' + itemTitle(it));
    if (it.type === 'link' && it.url) {
      lines.push(it.url);
      if (it.memo) lines.push('   ' + oneLine(it.memo, 90));
    } else if (it.type === 'memo') {
      if (it.memo) lines.push('   ' + oneLine(it.memo, 300));
    } else if (it.type === 'image') {
      if (it.memo) lines.push('   ' + oneLine(it.memo, 90));
    }
    if ((it.tags || []).length) lines.push('   ' + tagsToText(it.tags.slice(0, 4)));
    blocks.push(lines.join('\n'));
    blocks.push('');
  });

  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function itemShareText(item) {
  if (!item) return '';
  var parts = [itemTitle(item)];
  if (item.url) parts.push(item.url);
  if (item.memo) parts.push(oneLine(item.memo, 400));
  return parts.join('\n');
}

/* --------------------------------------------------------------- rendering */

function hueOf(seed) {
  var s = String(seed || 'x');
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function cardMediaHTML(item, ctx) {
  var src = (ctx && ctx.thumbSrc) || '';
  if (item.type === 'memo' && item.memo) {
    return '<div class="card-memo">' + esc(oneLine(item.memo, 220)) + '</div>';
  }
  if (src) {
    return '<div class="card-media media-shot"><img src="' + esc(src) + '" alt="" loading="lazy" decoding="async"></div>';
  }
  if (item.thumbnailUrl) {
    return '<div class="card-media"><img src="' + esc(item.thumbnailUrl) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"' +
      ' onerror="this.parentNode.classList.add(\'tile\');this.parentNode.style.setProperty(\'--hue\',' + hueOf(item.domain || item.url) + ');this.remove()"></div>';
  }
  var letter = item.type === 'image' ? '🖼' : (item.type === 'memo' ? '📝' : String(item.domain || domainOf(item.url) || 'link').replace(/^www\./, '').charAt(0));
  var hue = hueOf(item.domain || item.url || item.title || item.type);
  return '<div class="card-media tile" style="--hue:' + hue + '"><span class="tile-letter">' + esc(letter.toUpperCase()) + '</span></div>';
}

/**
 * 카드 한 장의 HTML. DOM 없이 문자열만 만든다(테스트 가능).
 * ctx: {folder, thumbSrc, selectionMode, selected, now}
 */
function renderCardHTML(item, ctx) {
  var c = ctx || {};
  var now = c.now || Date.now();
  var folder = c.folder || null;
  var picked = !!(c.selectionMode && c.selected);
  var star = !!item.favorite;
  var sel = !!c.selectionMode;
  // 제목 없이 저장한 메모는 카드에서 본문이 제목 역할을 한다 (리스트 보기에서는 제목 유지)
  var noTitle = item.type === 'memo' && !oneLine(item.title, 200);
  var title = itemTitle(item);
  var kicker;
  if (item.type === 'link') {
    kicker = '<span class="k-domain">' + esc(item.domain || domainOf(item.url) || '링크') + '</span>';
  } else {
    kicker = '<span class="k-type">' + esc(TYPE_LABEL[item.type] || '메모') + '</span>';
  }

  var note = '';
  if (item.type !== 'memo' && item.memo) {
    note = '<p class="card-note">' + esc(oneLine(item.memo, 160)) + '</p>';
  }

  var tags = (item.tags || []).slice(0, 3).map(function (t) {
    return '<span class="tag">#' + esc(t) + '</span>';
  }).join('');

  var folderName = folder ? folder.name : '미분류';
  var folderColor = folder ? (folder.color || 'var(--ink-3)') : 'var(--ink-3)';

  return '' +
    '<article class="card' + (picked ? ' picked' : '') + (star ? ' has-star' : '') + (noTitle ? ' no-title' : '') + '"' +
    ' data-id="' + esc(item.id) + '" data-type="' + esc(item.type) + '"' +
    ' role="button" tabindex="0" aria-label="' + esc(title + ' · ' + folderName) + '">' +
      cardMediaHTML(item, c) +
      (star ? '<span class="card-star" aria-hidden="true"><svg class="ico"><use href="#i-star"/></svg></span>' : '') +
      (sel ? '<span class="pick" aria-hidden="true"><svg class="ico"><use href="#i-check"/></svg></span>' : '') +
      '<div class="card-body">' +
        '<div class="card-kicker">' + kicker +
          (item.type === 'link' && item.siteName ? '<span class="k-dot"></span><span class="k-type">' + esc(truncate(item.siteName, 16)) + '</span>' : '') +
        '</div>' +
        '<h3 class="card-title">' + esc(title) + '</h3>' +
        note +
        (tags ? '<div class="card-tags">' + tags + '</div>' : '') +
        '<div class="card-foot">' +
          '<span class="f-folder"><span class="f-dot" style="background:' + esc(folderColor) + '"></span>' + esc(folderName) + '</span>' +
          '<time datetime="' + esc(isoDate(item.createdAt)) + '">' + esc(humanDate(item.createdAt, now)) + '</time>' +
        '</div>' +
      '</div>' +
    '</article>';
}

function renderEmptyHTML(opts) {
  var o = opts || {};
  var hasAny = o.total > 0;
  if (o.query) {
    return '<div class="empty">' +
      '<div class="empty-badge">🔍</div>' +
      '<h3>‘' + esc(truncate(o.query, 24)) + '’ 결과가 없어요</h3>' +
      '<p>다른 단어로 찾아보거나, 이 검색어로 새 스크랩을 만들어 보세요.</p>' +
      '<button type="button" class="btn ghost" data-act="clear-search">검색 지우기</button>' +
    '</div>';
  }
  if (hasAny && o.type && o.type !== 'all') {
    return '<div class="empty">' +
      '<div class="empty-badge">' + (TYPE_EMOJI[o.type] || '🗂️') + '</div>' +
      '<h3>' + esc(TYPE_LABEL[o.type] || '') + ' 스크랩이 없어요</h3>' +
      '<p>' + (o.folderName ? '‘' + esc(o.folderName) + '’ 폴더에 ' : '') + '이 종류로 저장된 게 아직 없어요.</p>' +
      '<button type="button" class="btn ghost" data-act="show-all-type">전체 종류 보기</button>' +
    '</div>';
  }
  if (hasAny) {
    return '<div class="empty">' +
      '<div class="empty-badge">🗂️</div>' +
      '<h3>' + esc(o.folderName || '이 폴더') + '가 비어 있어요</h3>' +
      '<p>이 폴더에 담을 링크·메모·이미지를 추가해 보세요.</p>' +
      '<button type="button" class="btn primary" data-act="add">스크랩 추가</button>' +
    '</div>';
  }
  return '<div class="empty">' +
    '<div class="empty-badge">📥</div>' +
    '<h3>아직 아무것도 없어요</h3>' +
    '<p>링크·메모·스크린샷을 한 번에 담아두는 나만의 스크랩박스예요. 로그인도 광고도 없어요.</p>' +
    '<button type="button" class="btn primary" data-act="add">첫 스크랩 추가</button>' +
  '</div>';
}

/* ------------------------------------------------------------------ folders */

function sortFolders(folders) {
  return (folders || []).slice().sort(function (a, b) {
    var asys = a.system ? 1 : 0, bsys = b.system ? 1 : 0;
    if (asys !== bsys) return asys - bsys; // 미분류 같은 기본 폴더는 맨 뒤
    var ao = num(a.order, 0), bo = num(b.order, 0);
    if (ao !== bo) return ao - bo;
    return String(a.name).localeCompare(String(b.name));
  });
}

function folderById(folders, id) {
  var list = folders || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/** '미분류'는 항상 있어야 하는 기본 폴더. 없으면 만들어 넣는다. */
function ensureBaseFolders(folders) {
  var list = (folders || []).map(function (f) { return Object.assign({}, f); });
  var inbox = folderById(list, 'inbox');
  if (!inbox) {
    list.unshift(Object.assign({}, DEFAULT_FOLDERS[0]));
  } else if (!inbox.system) {
    // 백업에서 되살린 '미분류'도 기본 폴더로 취급한다 (맨 뒤 고정)
    inbox.system = true;
    if (!inbox.emoji) inbox.emoji = '📥';
  }
  return sortFolders(list);
}

/** 폴더 순서를 한 칸 위/아래로. 원본을 건드리지 않고 새 배열을 돌려준다. */
function moveFolder(folders, id, dir) {
  var all = sortFolders(folders);
  var list = all.filter(function (f) { return !f.system; });
  var idx = -1;
  for (var i = 0; i < list.length; i++) if (list[i].id === id) idx = i;
  if (idx === -1) return all;
  var target = idx + (dir < 0 ? -1 : 1);
  if (target < 0 || target >= list.length) return all;
  var tmp = list[idx];
  list[idx] = list[target];
  list[target] = tmp;
  var next = list.map(function (f, i) { return Object.assign({}, f, { order: i }); });
  all.forEach(function (f) { if (f.system) next.push(Object.assign({}, f)); });
  return sortFolders(next);
}

function ensureUniqueFolderName(folders, name, exceptId) {
  var base = oneLine(name, 20) || '새 폴더';
  var taken = (folders || []).filter(function (f) { return f.id !== exceptId; })
    .map(function (f) { return String(f.name); });
  if (taken.indexOf(base) === -1) return base;
  for (var i = 2; i < 99; i++) {
    var cand = base + ' ' + i;
    if (taken.indexOf(cand) === -1) return cand;
  }
  return base + ' ' + Date.now().toString(36).slice(-3);
}

/* ------------------------------------------------------------ backup/import */

function validateBackup(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('JSON 형식이 아니에요.');
  if (!Array.isArray(raw.items)) throw new Error('items 목록을 찾을 수 없어요.');

  var warnings = [];
  var now = Date.now();
  var seenFolders = {};
  var folders = [];

  (Array.isArray(raw.folders) ? raw.folders : []).forEach(function (f, i) {
    if (!f || typeof f !== 'object') { warnings.push('폴더 ' + (i + 1) + ' 형식이 맞지 않아 건너뛰었어요.'); return; }
    var id = typeof f.id === 'string' && f.id ? f.id : uid('fd');
    if (seenFolders[id]) return;
    seenFolders[id] = 1;
    var name = oneLine(f.name, 20);
    if (!name) { warnings.push('이름 없는 폴더를 건너뛰었어요.'); return; }
    folders.push({
      id: id,
      name: name,
      emoji: (typeof f.emoji === 'string' && f.emoji.trim()) ? Array.from(f.emoji.trim()).slice(0, 2).join('') : '📁',
      color: /^#[0-9a-f]{6}$/i.test(f.color || '') ? f.color : COLOR_CHOICES[folders.length % COLOR_CHOICES.length],
      order: num(f.order, folders.length),
      system: !!f.system
    });
  });

  var seenIds = {};
  var items = [];
  raw.items.forEach(function (it, i) {
    if (!it || typeof it !== 'object') { warnings.push('항목 ' + (i + 1) + ' 형식이 맞지 않아 건너뛰었어요.'); return; }
    var type = (it.type === 'link' || it.type === 'image' || it.type === 'memo') ? it.type
      : (it.url ? 'link' : (it.image ? 'image' : 'memo'));
    var title = oneLine(it.title, 300);
    var memo = typeof it.memo === 'string' ? it.memo.slice(0, 2000) : '';
    var url = '';
    if (typeof it.url === 'string' && it.url) {
      var n = normalizeUrl(it.url);
      url = n.ok ? n.url : '';
    }
    if (!title && !memo && !url && !it.image) {
      warnings.push('빈 항목 ' + (i + 1) + '을(를) 건너뛰었어요.');
      return;
    }
    var id = typeof it.id === 'string' && it.id ? it.id : uid('it');
    if (seenIds[id]) id = uid('it');
    seenIds[id] = 1;

    var createdAt = num(it.createdAt, 0) || now;
    items.push({
      id: id,
      type: type,
      title: title,
      memo: memo,
      url: url,
      domain: url ? (it.domain || domainOf(url)) : '',
      folderId: typeof it.folderId === 'string' && it.folderId ? it.folderId : 'inbox',
      tags: normalizeTags(it.tags),
      favorite: !!it.favorite,
      createdAt: createdAt,
      updatedAt: num(it.updatedAt, createdAt),
      thumbnailUrl: typeof it.thumbnailUrl === 'string' ? it.thumbnailUrl : '',
      description: typeof it.description === 'string' ? it.description.slice(0, 600) : '',
      siteName: typeof it.siteName === 'string' ? it.siteName.slice(0, 60) : '',
      image: it.image || null,
      thumb: it.thumb || null,
      width: num(it.width, 0),
      height: num(it.height, 0)
    });
  });

  return {
    folders: folders,
    items: items,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    warnings: warnings
  };
}

/* =============================================================================
   Part 2 / 저장소 · 상태 · 렌더링
   ============================================================================= */

var DB_NAME = 'scrapbox_db';
var DB_VERSION = 1;
var LS_SETTINGS = 'scrapbox_settings_v1';

var dbPromise = null;
var blobUrls = new WeakMap();

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('이 브라우저에서는 저장소를 쓸 수 없어요.'));
      return;
    }
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        var items = db.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('createdAt', 'createdAt');
        items.createIndex('folderId', 'folderId');
      }
      if (!db.objectStoreNames.contains('folders')) {
        var folders = db.createObjectStore('folders', { keyPath: 'id' });
        folders.createIndex('order', 'order');
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('저장소를 열지 못했어요.')); };
    req.onblocked = function () { reject(new Error('다른 창에서 저장소를 쓰고 있어요. 그 창을 닫고 다시 시도해 주세요.')); };
  });
  return dbPromise;
}

function dbAll(storeName) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function dbPut(storeName, value) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = function () { resolve(value); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function dbPutMany(storeName, values) {
  if (!values.length) return Promise.resolve();
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readwrite');
      var store = tx.objectStore(storeName);
      values.forEach(function (v) { store.put(v); });
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function dbDelete(storeName, key) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function dbClear(storeName) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function blobUrl(blob) {
  if (!blob) return '';
  var cached = blobUrls.get(blob);
  if (cached) return cached;
  var url = URL.createObjectURL(blob);
  blobUrls.set(blob, url);
  return url;
}

function thumbSrcFor(item) {
  if (!item) return '';
  if (item.thumb) return blobUrl(item.thumb);
  if (item.image) return blobUrl(item.image);
  return '';
}

/* ------------------------------------------------------------------ state */

var settings = { theme: 'auto', view: 'card', preview: true };

var state = {
  items: [],
  folders: [],
  folderId: 'all',
  query: '',
  type: 'all',
  view: 'card',
  visible: [],
  selectMode: false,
  selected: new Set(),
  detailId: null,
  editingId: null,
  addType: 'link',
  addImages: [],
  addPreview: null,
  addPreviewFor: '',
  addExistingThumb: '',
  paletteFolderId: null,
  ready: false
};

var ui = {};
var searchTimer = null;
var previewTimer = null;
var previewAbort = null;

function cacheUI() {
  ['searchInput', 'searchClear', 'quickCapture', 'quickInput', 'folderBar', 'itemArea', 'viewTitle', 'viewCount',
    'typeSeg', 'btnView', 'viewIcon', 'viewIconUse', 'btnBundle', 'btnSelect', 'btnQuickAdd', 'btnSettings', 'fab', 'topbar',
    'selectionBar', 'selCount', 'selCopy', 'selMove', 'selDelete', 'selCancel', 'toasts',
    'addSheet', 'addHeading', 'addTypeSeg', 'addUrl', 'btnPasteUrl', 'previewCard',
    'previewThumb', 'previewTitle', 'previewDesc', 'previewHint', 'btnPreviewClear',
    'fileInput', 'btnPickImage', 'btnPasteImage', 'imgStrip', 'imageHint', 'titleLabel', 'addTitleInput',
    'memoLabel', 'addMemo', 'memoCount', 'addFolderChips', 'addTags', 'addFav', 'btnSave',
    'detailSheet', 'detailBody', 'btnFav', 'btnEdit', 'btnItemDelete',
    'folderSheet', 'folderList', 'newFolderName', 'btnAddFolder', 'palette',
    'paletteEmojis', 'paletteColors', 'settingsSheet', 'themeSeg', 'viewSeg',
    'previewToggle', 'btnExport', 'btnImport', 'importInput', 'statGrid',
    'confirmSheet', 'confirmTitle', 'confirmText', 'confirmActions', 'viewIcon'
  ].forEach(function (id) { ui[id] = document.getElementById(id); });
}

function loadSettings() {
  try {
    var s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
    settings.theme = (s.theme === 'light' || s.theme === 'dark') ? s.theme : 'auto';
    settings.view = s.view === 'list' ? 'list' : 'card';
    settings.preview = s.preview !== false;
  } catch (e) { /* 기본값 */ }
  state.view = settings.view;
}

function saveSettings(patch) {
  Object.assign(settings, patch || {});
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) { /* noop */ }
}

function prefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme() {
  var dark = settings.theme === 'dark' || (settings.theme === 'auto' && prefersDark());
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  if (ui.themeSeg) {
    Array.prototype.forEach.call(ui.themeSeg.querySelectorAll('button'), function (b) {
      var on = b.getAttribute('data-theme-opt') === settings.theme;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
}

/* ------------------------------------------------------------- rendering */

function currentFolder() {
  if (state.folderId === 'all') return { id: 'all', name: '전체' };
  if (state.folderId === 'fav') return { id: 'fav', name: '즐겨찾기', emoji: '★' };
  return folderById(state.folders, state.folderId) || { id: 'all', name: '전체' };
}

function folderChipsHTML() {
  var counts = countByFolder(state.items);
  var out = [];

  // '+ 폴더' 칩은 목록 맨 앞에 둔다 (스크롤 없이 바로 보이게).
  out.push('<button type="button" class="chip add" data-folder-manage aria-haspopup="dialog" aria-label="폴더 관리">' +
    '<svg class="ico" aria-hidden="true"><use href="#i-plus"/></svg>' +
    '<span>폴더</span></button>');

  out.push(chipHTML('all', '전체', '', counts.all || 0));
  out.push(chipHTML('fav', '즐겨찾기', '★', counts.fav || 0));

  sortFolders(state.folders).forEach(function (f) {
    out.push(chipHTML(f.id, f.name, f.emoji || '📁', counts[f.id] || 0, f.color));
  });

  return out.join('');
}

function chipHTML(id, name, mark, count, color) {
  var on = state.folderId === id;
  var markHTML = mark
    ? '<span class="chip-emoji" style="' + (color ? 'color:' + esc(color) : '') + '">' + esc(mark) + '</span>'
    : '';
  return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-folder="' + esc(id) + '"' +
    ' aria-pressed="' + (on ? 'true' : 'false') + '">' +
    markHTML + '<span>' + esc(name) + '</span>' +
    (count ? '<span class="chip-count">' + count + '</span>' : '') +
    '</button>';
}

function render() {
  if (!state.ready) return;

  ui.folderBar.innerHTML = folderChipsHTML();

  var folder = currentFolder();
  var filtered = filterItems(state.items, {
    folderId: state.folderId,
    query: state.query,
    type: state.type
  });
  state.visible = filtered;

  ui.viewTitle.textContent = state.query ? '검색 결과' : folder.name;
  ui.viewCount.textContent = filtered.length ? String(filtered.length) : '';

  var byId = {};
  state.folders.forEach(function (f) { byId[f.id] = f; });

  ui.itemArea.dataset.view = state.view;
  if (filtered.length) {
    var html = filtered.map(function (it) {
      return renderCardHTML(it, {
        folder: byId[it.folderId || 'inbox'] || null,
        thumbSrc: thumbSrcFor(it),
        selectionMode: state.selectMode,
        selected: state.selected.has(it.id)
      });
    }).join('');
    ui.itemArea.innerHTML = html;
  } else {
    ui.itemArea.innerHTML = renderEmptyHTML({
      query: state.query,
      folderName: folder.name,
      type: state.type,
      total: state.items.length
    });
  }

  Array.prototype.forEach.call(ui.typeSeg.querySelectorAll('button'), function (b) {
    var on = b.getAttribute('data-type') === state.type;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  if (ui.viewIconUse) ui.viewIconUse.setAttribute('href', state.view === 'card' ? '#i-grid' : '#i-list');
  ui.btnBundle.hidden = !filtered.length;
  ui.searchClear.hidden = !state.query;

  renderSelection();
  renderStats();
}

function renderSelection() {
  var n = state.selected.size;
  ui.selectionBar.hidden = !state.selectMode;
  ui.selCount.textContent = n + '개 선택';
  ui.selCopy.disabled = n === 0;
  ui.selMove.disabled = n === 0;
  ui.selDelete.disabled = n === 0;
  ui.btnSelect.setAttribute('aria-pressed', state.selectMode ? 'true' : 'false');
  var selLabel = ui.btnSelect.querySelector ? ui.btnSelect.querySelector('.icon-btn-label') : null;
  if (selLabel) selLabel.textContent = state.selectMode ? '완료' : '선택';
  document.body.classList.toggle('selecting', state.selectMode);
}

function syncSelectionDOM() {
  Array.prototype.forEach.call(ui.itemArea.querySelectorAll('.card'), function (card) {
    card.classList.toggle('picked', state.selected.has(card.getAttribute('data-id')));
  });
  renderSelection();
}

function renderStats() {
  if (!ui.statGrid) return;
  var images = state.items.filter(function (i) { return i.type === 'image'; }).length;
  var links = state.items.filter(function (i) { return i.type === 'link'; }).length;

  function paint(usageText) {
    ui.statGrid.innerHTML =
      '<div class="stat"><b>' + state.items.length + '</b><span>전체 항목</span></div>' +
      '<div class="stat"><b>' + links + '</b><span>링크</span></div>' +
      '<div class="stat"><b>' + (images ? images : 0) + '</b><span>이미지</span></div>' +
      '<div class="stat"><b>' + state.folders.length + '</b><span>폴더</span></div>' +
      '<div class="stat"><b>' + (countByFolder(state.items).fav || 0) + '</b><span>즐겨찾기</span></div>' +
      '<div class="stat"><b>' + usageText + '</b><span>사용 용량</span></div>';
  }

  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(function (e) {
      paint(formatBytes(e.usage || 0));
    }).catch(function () { paint('—'); });
  } else {
    paint('—');
  }
}

function formatBytes(bytes) {
  var b = num(bytes, 0);
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + 'KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + 'MB';
  return (b / 1024 / 1024 / 1024).toFixed(1) + 'GB';
}

/* --------------------------------------------------------------- feedback */

function toast(message, opts) {
  var o = opts || {};
  var el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<span>' + esc(message) + '</span>' +
    (o.action ? '<button type="button" class="t-action">' + esc(o.action) + '</button>' : '');
  ui.toasts.appendChild(el);

  var removed = false;
  function remove() {
    if (removed) return;
    removed = true;
    el.classList.add('leaving');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }
  var timer = setTimeout(remove, o.duration || (o.action ? 5200 : 2800));
  var actionBtn = el.querySelector('.t-action');
  if (actionBtn && o.onAction) {
    actionBtn.addEventListener('click', function () {
      clearTimeout(timer);
      remove();
      o.onAction();
    });
  }
  return el;
}

function copyText(text) {
  var value = String(text == null ? '' : text);
  if (!value) return Promise.resolve(false);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(value).then(function () { return true; }).catch(function () {
      return legacyCopy(value);
    });
  }
  return Promise.resolve(legacyCopy(value));
}

function legacyCopy(value) {
  try {
    var ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

/* ---------------------------------------------------------------- sheets */

var openSheets = [];

function openSheet(el) {
  if (!el) return;
  if (openSheets.indexOf(el) === -1) openSheets.push(el);
  el.classList.remove('closing');
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('locked');
  var focusable = el.querySelector('input:not([type=hidden]), textarea, button');
  if (focusable && !el.hasAttribute('data-no-autofocus')) {
    setTimeout(function () {
      var first = el.querySelector('input:not([type=hidden]):not([readonly]), textarea');
      if (first && window.innerWidth > 760) { try { first.focus(); } catch (e) { /* noop */ } }
    }, 120);
  }
}

function closeSheet(el) {
  if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open');
  el.classList.add('closing');
  el.setAttribute('aria-hidden', 'true');
  setTimeout(function () { el.classList.remove('closing'); }, 300);
  var i = openSheets.indexOf(el);
  if (i !== -1) openSheets.splice(i, 1);
  if (!openSheets.length) document.body.classList.remove('locked');
}

function closeTopSheet() {
  var el = openSheets[openSheets.length - 1];
  if (!el) return false;
  if (el === ui.confirmSheet) { resolveConfirm(null); return true; }
  if (el === ui.detailSheet) state.detailId = null;
  closeSheet(el);
  return true;
}

/* --------------------------------------------------------- confirm dialog */

var confirmResolve = null;
var confirmValues = [];

function askConfirm(opts) {
  var o = opts || {};
  confirmValues = o.actions || [{ label: '확인', value: true, style: 'primary' }];
  ui.confirmTitle.textContent = o.title || '확인';
  ui.confirmText.textContent = o.text || '';
  ui.confirmActions.innerHTML = (o.actions || [{ label: '확인', value: true, style: 'primary' }])
    .map(function (a, i) {
      return '<button type="button" class="btn ' + (a.style || 'ghost') + '" data-ci="' + i + '">' + esc(a.label) + '</button>';
    }).join('');
  openSheet(ui.confirmSheet);

  return new Promise(function (resolve) {
    confirmResolve = resolve;
  });
}

function resolveConfirm(value) {
  var r = confirmResolve;
  confirmResolve = null;
  closeSheet(ui.confirmSheet);
  if (r) r(value);
}

/* =============================================================================
   Part 3 / 빠른 추가 · 이미지 처리
   ============================================================================= */

function upsertItem(item) {
  item.updatedAt = Date.now();
  var idx = -1;
  for (var i = 0; i < state.items.length; i++) if (state.items[i].id === item.id) idx = i;
  if (idx >= 0) state.items[idx] = item;
  else state.items.push(item);
  return dbPut('items', item).catch(function (err) {
    toast('저장하지 못했어요: ' + ((err && err.message) || '알 수 없는 오류'));
    throw err;
  });
}

function removeItemEverywhere(id) {
  var kept = [];
  var found = null;
  state.items.forEach(function (it) {
    if (it.id === id) found = it;
    else kept.push(it);
  });
  state.items = kept;
  return found;
}

function toggleFavorite(id) {
  var it = null;
  state.items.forEach(function (x) { if (x.id === id) it = x; });
  if (!it) return;
  it.favorite = !it.favorite;
  it.updatedAt = Date.now();
  dbPut('items', it).then(render).catch(function () { toast('저장하지 못했어요'); });
  return it.favorite;
}

/* ---------------------------------------------------------------- add form */

function updateMemoCount() {
  if (ui.memoCount && ui.addMemo) ui.memoCount.textContent = ui.addMemo.value.length + ' / 2000';
}

function resetAddForm() {
  state.editingId = null;
  state.addImages.forEach(function (entry) {
    if (entry && entry.url) { try { URL.revokeObjectURL(entry.url); } catch (e) { /* noop */ } }
  });
  state.addImages = [];
  state.addPreview = null;
  state.addPreviewFor = '';
  state.addExistingThumb = '';
  state.addFolderId = 'inbox';

  ui.addHeading.textContent = '새 스크랩';
  ui.btnSave.textContent = '저장';
  ui.btnSave.disabled = false;
  ui.addUrl.value = '';
  ui.addTitleInput.value = '';
  ui.addMemo.value = '';
  ui.addTags.value = '';
  ui.addFav.setAttribute('aria-checked', 'false');
  ui.titleLabel.innerHTML = '제목 <em>선택</em>';
  hidePreview();
  ui.previewHint.textContent = '주소를 붙여넣으면 제목·썸네일을 자동으로 채워요.';
  ui.imageHint.textContent = '큰 이미지는 가로 ' + MAX_IMAGE_WIDTH + 'px로 자동 줄여 저장해요.';
  ui.fileInput.value = '';
  renderImgStrip();
  renderAddFolderChips();
  setAddType('link', false);
  updateMemoCount();
  Array.prototype.forEach.call(ui.addTypeSeg.querySelectorAll('button'), function (b) { b.disabled = false; });
}

function setAddType(type, userInitiated) {
  if (state.editingId) return; // 편집 중에는 종류를 바꾸지 않는다
  state.addType = (type === 'image' || type === 'memo') ? type : 'link';
  Array.prototype.forEach.call(ui.addSheet.querySelectorAll('[data-pane]'), function (p) {
    p.hidden = p.getAttribute('data-pane') !== state.addType;
  });
  Array.prototype.forEach.call(ui.addTypeSeg.querySelectorAll('button'), function (b) {
    var on = b.getAttribute('data-addtype') === state.addType;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  if (state.addType === 'memo') {
    ui.memoLabel.textContent = '본문';
    ui.addMemo.placeholder = '생각나는 대로 적어두세요. 제목 없이도 저장돼요.';
    ui.addTitleInput.placeholder = '비워두면 본문 첫 줄로 채워요';
    ui.addMemo.rows = 6;
  } else if (state.addType === 'image') {
    ui.memoLabel.textContent = '메모';
    ui.addMemo.placeholder = '이 스크린샷을 왜 저장했는지 한 줄';
    ui.addTitleInput.placeholder = '비워두면 이미지로 저장돼요';
    ui.addMemo.rows = 2;
  } else {
    ui.memoLabel.textContent = '메모';
    ui.addMemo.placeholder = '나중에 이걸 왜 저장했는지 한 줄';
    ui.addTitleInput.placeholder = '비워두면 페이지 제목으로 채워요';
    ui.addMemo.rows = 2;
  }
  if (userInitiated && state.addType === 'link' && !state.editingId) {
    setTimeout(function () { try { ui.addUrl.focus(); } catch (e) { /* noop */ } }, 60);
  }
}

function renderAddFolderChips() {
  var selected = state.addFolderId || 'inbox';
  var list = sortFolders(state.folders);
  var html = list.map(function (f) {
    var on = f.id === selected;
    return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-addfolder="' + esc(f.id) + '"' +
      ' aria-pressed="' + (on ? 'true' : 'false') + '">' +
      '<span class="chip-emoji">' + esc(f.emoji || '📁') + '</span><span>' + esc(f.name) + '</span></button>';
  }).join('');
  ui.addFolderChips.innerHTML = html;
}

function openAdd(opts) {
  var o = opts || {};
  resetAddForm();

  if (o.item) {
    var item = o.item;
    state.editingId = item.id;
    state.addFolderId = item.folderId || 'inbox';
    ui.addHeading.textContent = '스크랩 편집';
    ui.btnSave.textContent = '수정 저장';
    state.addType = item.type;
    Array.prototype.forEach.call(ui.addSheet.querySelectorAll('[data-pane]'), function (p) {
      p.hidden = p.getAttribute('data-pane') !== item.type;
    });
    Array.prototype.forEach.call(ui.addTypeSeg.querySelectorAll('button'), function (b) {
      var on = b.getAttribute('data-addtype') === item.type;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.disabled = true;
    });
    ui.addUrl.value = item.url || '';
    ui.addTitleInput.value = item.title || '';
    ui.addMemo.value = item.memo || '';
    ui.addTags.value = tagsToText(item.tags);
    ui.addFav.setAttribute('aria-checked', item.favorite ? 'true' : 'false');
    if (item.type === 'image') {
      state.addExistingThumb = thumbSrcFor(item);
      ui.imageHint.textContent = '이미지를 새로 고르면 교체돼요.';
      renderImgStrip();
    }
    if (item.type === 'link' && (item.thumbnailUrl || item.description)) {
      state.addPreview = { title: item.title, desc: item.description || '', thumb: item.thumbnailUrl || '' };
      state.addPreviewFor = item.url;
      showPreview(state.addPreview);
    }
    if (item.type === 'memo') {
      ui.memoLabel.textContent = '본문';
      ui.addMemo.rows = 6;
    }
    updateMemoCount();
    renderAddFolderChips();
    openSheet(ui.addSheet);
    return;
  }

  var type = o.type || 'link';
  if (type === 'image' && !o.images) type = o.url ? 'link' : 'image';
  var preFolder = (state.folderId !== 'all' && state.folderId !== 'fav' && folderById(state.folders, state.folderId))
    ? state.folderId : 'inbox';
  state.addFolderId = o.folderId && folderById(state.folders, o.folderId) ? o.folderId : preFolder;

  if (o.url) ui.addUrl.value = o.url;
  if (o.title) ui.addTitleInput.value = o.title;
  if (o.memo) ui.addMemo.value = o.memo;
  if (o.tags) ui.addTags.value = tagsToText(o.tags);
  if (o.favorite) ui.addFav.setAttribute('aria-checked', 'true');
  if (type === 'memo') state.addType = 'memo';
  setAddType(type, false);
  updateMemoCount();
  renderAddFolderChips();
  openSheet(ui.addSheet);

  if (o.url) {
    ui.addUrl.value = o.url;
    schedulePreview();
  }
  if (o.images && o.images.length) {
    addFilesToAdd(o.images);
    setAddType('image', false);
  }
}

function collectAddFields() {
  return {
    title: ui.addTitleInput.value.trim(),
    memo: ui.addMemo.value.trim(),
    tags: extractTags(ui.addTags.value),
    favorite: ui.addFav.getAttribute('aria-checked') === 'true',
    folderId: state.addFolderId || 'inbox'
  };
}

function reconcileTypeFilter(type) {
  if (state.type !== 'all' && state.type !== type) state.type = 'all';
}

function saveAdd() {
  if (state.editingId) return saveEdit();
  var f = collectAddFields();

  if (state.addType === 'link') {
    var n = normalizeUrl(ui.addUrl.value);
    if (!n.ok) {
      toast('주소를 확인해 주세요. 예: https://example.com');
      try { ui.addUrl.focus(); } catch (e) { /* noop */ }
      return;
    }
    var p = state.addPreview && state.addPreviewFor === n.url ? state.addPreview : null;
    var item = {
      id: uid('it'),
      type: 'link',
      url: n.url,
      domain: n.domain,
      title: f.title || (p && p.title) || fallbackTitle({ type: 'link', url: n.url, domain: n.domain }),
      memo: f.memo || (p && p.desc ? oneLine(p.desc, 300) : ''),
      folderId: f.folderId,
      tags: f.tags,
      favorite: f.favorite,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      thumbnailUrl: (p && p.thumb) || '',
      description: (p && p.desc) || '',
      siteName: (p && p.site) || ''
    };
    upsertItem(item).then(function () {
      reconcileTypeFilter('link');
      closeSheet(ui.addSheet);
      render();
      toast('링크를 저장했어요');
    }).catch(function () { /* 토스트는 upsertItem에서 */ });
    return;
  }

  if (state.addType === 'memo') {
    if (!f.title && !f.memo) {
      toast('내용을 적어 주세요');
      try { ui.addMemo.focus(); } catch (e) { /* noop */ }
      return;
    }
    var memoItem = {
      id: uid('it'),
      type: 'memo',
      title: f.title || fallbackTitle({ type: 'memo', memo: f.memo }),
      memo: f.memo,
      folderId: f.folderId,
      tags: f.tags,
      favorite: f.favorite,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      url: '',
      domain: ''
    };
    upsertItem(memoItem).then(function () {
      reconcileTypeFilter('memo');
      closeSheet(ui.addSheet);
      render();
      toast('메모를 저장했어요');
    }).catch(function () { /* noop */ });
    return;
  }

  // 이미지
  if (!state.addImages.length) {
    toast('이미지를 먼저 골라 주세요');
    return;
  }
  saveAddImages(f);
}

function saveAddImages(f) {
  var total = state.addImages.length;
  ui.btnSave.disabled = true;
  ui.btnSave.textContent = '저장 중 1/' + total;

  var made = [];
  var fallbackCount = 0;

  function step(i) {
    if (i >= total) return finish();
    ui.btnSave.textContent = '저장 중 ' + (i + 1) + '/' + total;
    var entry = state.addImages[i];
    return packImage(entry.file).then(function (packed) {
      if (!packed.thumb) fallbackCount++;
      var title = total > 1 ? (f.title ? f.title + ' ' + (i + 1) : '') : f.title;
      made.push({
        id: uid('it'),
        type: 'image',
        title: title,
        memo: i === 0 ? f.memo : '',
        folderId: f.folderId,
        tags: f.tags,
        favorite: f.favorite,
        createdAt: Date.now() + i,
        updatedAt: Date.now(),
        url: '',
        domain: '',
        image: packed.image,
        thumb: packed.thumb,
        width: packed.width,
        height: packed.height,
        mime: packed.mime || ''
      });
      return step(i + 1);
    });
  }

  function finish() {
    return dbPutMany('items', made).then(function () {
      state.items = state.items.concat(made);
      reconcileTypeFilter('image');
      closeSheet(ui.addSheet);
      render();
      if (fallbackCount) toast(made.length + '장 저장 · ' + fallbackCount + '장은 원본 그대로 담았어요');
      else toast(total > 1 ? made.length + '장을 저장했어요' : '이미지를 저장했어요');
    }).catch(function () {
      toast('이미지를 저장하지 못했어요. 용량이 부족한지 확인해 주세요.');
    }).then(function () {
      ui.btnSave.disabled = false;
      ui.btnSave.textContent = '저장';
    });
  }

  return step(0);
}

function saveEdit() {
  var id = state.editingId;
  var it = null;
  state.items.forEach(function (x) { if (x.id === id) it = x; });
  if (!it) { closeSheet(ui.addSheet); resetAddForm(); return; }

  var f = collectAddFields();
  var next = Object.assign({}, it);

  if (it.type === 'link') {
    var n = normalizeUrl(ui.addUrl.value);
    if (!n.ok) {
      toast('주소를 확인해 주세요');
      return;
    }
    next.url = n.url;
    next.domain = n.domain;
    if (state.addPreview && state.addPreviewFor === n.url) {
      next.thumbnailUrl = state.addPreview.thumb || '';
      next.description = state.addPreview.desc || '';
      next.siteName = state.addPreview.site || next.siteName || '';
    }
  }
  next.title = f.title;
  next.memo = f.memo;
  next.tags = f.tags;
  next.favorite = f.favorite;
  next.folderId = f.folderId;

  if (it.type === 'image' && state.addImages.length) {
    ui.btnSave.disabled = true;
    ui.btnSave.textContent = '이미지 교체 중';
    packImage(state.addImages[0].file).then(function (packed) {
      next.image = packed.image;
      next.thumb = packed.thumb;
      next.width = packed.width;
      next.height = packed.height;
      next.mime = packed.mime || '';
      return upsertItem(next);
    }).then(function () {
      ui.btnSave.disabled = false;
      ui.btnSave.textContent = '저장';
      finishEdit();
    }).catch(function () {
      ui.btnSave.disabled = false;
      ui.btnSave.textContent = '저장';
      toast('이미지를 교체하지 못했어요');
    });
    return;
  }

  upsertItem(next).then(finishEdit).catch(function () { /* noop */ });
}

function finishEdit() {
  var id = state.editingId;
  var edited = id ? findItem(id) : null;
  if (edited) reconcileTypeFilter(edited.type);
  closeSheet(ui.addSheet);
  render();
  if (state.detailId === id) {
    var it = null;
    state.items.forEach(function (x) { if (x.id === id) it = x; });
    if (it) renderDetail(it);
  }
  toast('수정했어요');
}

/* ------------------------------------------------------------- preview fetch */

function hidePreview() {
  ui.previewCard.hidden = true;
  ui.previewThumb.className = 'preview-thumb';
  ui.previewThumb.style.backgroundImage = '';
  ui.previewTitle.textContent = '';
  ui.previewDesc.textContent = '';
}

function showPreview(p, loading) {
  ui.previewCard.hidden = false;
  ui.previewThumb.className = 'preview-thumb' + (loading ? ' loading' : '');
  ui.previewThumb.style.backgroundImage = p && p.thumb ? 'url("' + String(p.thumb).replace(/"/g, '%22') + '")' : '';
  ui.previewTitle.textContent = loading ? '미리보기 가져오는 중…' : (p && p.title) || '';
  ui.previewDesc.textContent = (p && (p.site || p.desc)) || '';
}

function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  var raw = ui.addUrl.value.trim();
  if (!raw) { hidePreview(); return; }
  var n = normalizeUrl(raw);
  if (!n.ok) { hidePreview(); return; }
  if (state.addPreviewFor === n.url && state.addPreview) {
    showPreview(state.addPreview);
    return;
  }
  if (!settings.preview) {
    ui.previewHint.textContent = '자동 미리보기가 꺼져 있어요. 설정에서 켤 수 있어요.';
    return;
  }
  ui.previewHint.textContent = '주소를 붙여넣으면 제목·썸네일을 자동으로 채워요.';
  showPreview(null, true);
  previewTimer = setTimeout(function () { fetchPreviewInto(n); }, 600);
}

/* ------------------------------------------------------------- preview fetch */

/* 링크 미리보기는 정적 GitHub Pages 앱이라 브라우저가 외부 사이트를 직접 부른다.
   대부분의 사이트는 CORS를 열어주지 않으므로 '대신 받아 주는' 경로를 거친 뒤 받은 HTML에서
   og/twitter 메타를 직접 파싱한다. 순서는 2026-11-24 실제 호출로 확인해 정했다.
   · api.microlink.io — 무료 한도가 하루 5회(x-rate-limit-limit: 5)라 1순위에서 내렸다.
   · api.allorigins.win · api.codetabs.com — 자주 5xx(522)로 죽어 있어 뒤쪽에만 둔다.
   · cors.eu.org — 국내 뉴스·공공기관 페이지의 원문 HTML을 1~5초에 준다(확인).
   · r.jina.ai — 원문을 막는 사이트(네이버 블로그 등)도 렌더링한 HTML을 준다(확인).
   · noembed.com — 일반 웹페이지는 지원하지 않아 마지막 안전망으로만 쓴다. */

var PREVIEW_BUDGET_MS = 22000;
var PREVIEW_CACHE_KEY = 'scrapbox_preview_cache_v1';
var PREVIEW_CACHE_TTL = 7 * 86400000;
var PREVIEW_CACHE_MAX = 150;

/** 응답 바이트를 charset 선언(헤더 → <meta charset>)대로 풀고, 깨지면 utf-8/euc-kr을 견줘 고른다. */
function decodeBufferText(buf, contentType) {
  if (!buf || !buf.byteLength) return '';
  var bytes = new Uint8Array(buf);
  var charset = '';
  var m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  if (m) charset = m[1].toLowerCase();
  if (!charset) {
    var probe = '';
    // 바이트를 그대로 1:1로 읽을 수 있는 latin1로 앞부분만 훔쳐 <meta charset>을 찾는다
    try { probe = new TextDecoder('latin1').decode(bytes.subarray(0, 4096)); } catch (e) { probe = ''; }
    var m2 = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(probe);
    if (m2) charset = m2[1].toLowerCase();
  }

  var labels = [];
  [charset, 'utf-8', 'euc-kr'].forEach(function (label) {
    if (label && labels.indexOf(label) === -1) labels.push(label);
  });

  var best = '';
  var bestBad = Infinity;
  labels.forEach(function (label) {
    var text;
    try { text = new TextDecoder(label).decode(bytes); } catch (e) { return; }
    var bad = (text.match(/\uFFFD/g) || []).length;
    if (bad < bestBad) { bestBad = bad; best = text; }
  });
  return best;
}

function firstText(list) {
  for (var i = 0; i < (list || []).length; i++) {
    var v = list[i];
    if (v != null && String(v).trim()) return String(v);
  }
  return '';
}

/** 차단·오류 페이지가 돌려준 제목은 미리보기로 쓰지 않는다. */
var PREVIEW_JUNK_TITLE = /^(access denied|sorry!?[, ]*access denied|forbidden|attention required|just a moment|error code:? *\d+|4\d\d (forbidden|not found)|service unavailable|오류가 발생|접근이 거부|접속이 차단|권한이 없습니다)/i;
var PREVIEW_JUNK_DESC = /(access denied|you don'?t have permission|접근할 수 있는 권한이 없습니다|접속이 차단되었습니다|자동화된 요청)/i;

/* 사이트 이름(og:site_name)이 없을 때도 흔히 붙는 꼬리표는 떼어 낸다. */
var KNOWN_TITLE_SUFFIX = ['네이버 블로그', '네이버 뉴스', '네이버 카페', '네이버 포스트', '티스토리', 'youtube', '인스타그램'];

/** "제목 : 사이트이름" 처럼 사이트 이름이 꼬리에 붙은 것만 떼어 낸다(제목 자체는 건드리지 않는다). */
function cleanPreviewTitle(raw, site) {
  var s = String(raw == null ? '' : raw).replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  var st = String(site == null ? '' : site).replace(/\s+/g, ' ').trim().toLowerCase();
  var names = st ? [st] : KNOWN_TITLE_SUFFIX;
  var seps = [' : ', ' :: ', ' | ', ' - ', ' · ', ' — '];
  for (var n = 0; n < names.length; n++) {
    var lower = s.toLowerCase();
    var stripped = false;
    for (var i = 0; i < seps.length; i++) {
      var suffix = seps[i] + names[n];
      if (lower.length > suffix.length + 2 && lower.slice(-suffix.length) === suffix) {
        s = s.slice(0, s.length - suffix.length).trim();
        stripped = true;
        break;
      }
    }
    if (stripped) break;
  }
  return s;
}

function cleanPreviewDesc(raw) {
  var s = oneLine(raw, 400);
  if (!s) return '';
  if (PREVIEW_JUNK_DESC.test(s)) return '';
  return s;
}

/** og:image 같은 상대 주소를 절대 주소로. https 화면에서 http 이미지는 차단되므로 올려 본다. */
function resolvePreviewImage(ref, pageUrl) {
  var s = String(ref == null ? '' : ref).trim();
  if (!s || /^(data|blob|javascript):/i.test(s)) return '';
  try {
    var u = new URL(s, pageUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.protocol === 'http:' && /^https:/i.test(String(pageUrl))) u.protocol = 'https:';
    return u.href;
  } catch (e) { return ''; }
}

/** 받은 HTML에서 제목·설명·썸네일·사이트 이름을 뽑는다. 메타는 <head>에 있으므로 앞부분만 파싱한다. */
function parseMetaFromHTML(html, pageUrl) {
  if (!html || typeof html !== 'string') return null;
  var slice = html.length > 300000 ? html.slice(0, 300000) : html;
  var doc = null;
  try { doc = new DOMParser().parseFromString(slice, 'text/html'); } catch (e) { doc = null; }
  if (!doc) return null;

  var meta = {};
  var nodes = doc.querySelectorAll('meta');
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var key = String(n.getAttribute('property') || n.getAttribute('name') || n.getAttribute('itemprop') || '')
      .trim().toLowerCase();
    if (!key || meta[key] != null) continue;
    var content = n.getAttribute('content');
    if (content == null) continue;
    var val = String(content).replace(/\s+/g, ' ').trim();
    if (val) meta[key] = val;
  }

  var site = firstText([meta['og:site_name'], meta['application-name'], meta['apple-mobile-web-app-title']]);
  var title = firstText([meta['og:title'], meta['twitter:title'], meta['title'], doc.title]);
  var desc = firstText([meta['og:description'], meta['twitter:description'], meta['description'], meta['summary']]);
  var img = firstText([meta['og:image:secure_url'], meta['og:image'], meta['og:image:url'],
    meta['twitter:image'], meta['twitter:image:src'], meta['thumbnailurl']]);

  if (!img) {
    var link = doc.querySelector('link[rel~="image_src"]');
    if (link) img = link.getAttribute('href') || '';
  }

  site = cleanPreviewTitle(site, '');
  title = cleanPreviewTitle(title, site);
  if (!title) return null;
  if (title.length < 60 && PREVIEW_JUNK_TITLE.test(title)) return null;

  return {
    title: truncate(title, 160),
    desc: truncate(cleanPreviewDesc(desc), 300),
    thumb: resolvePreviewImage(img, pageUrl),
    site: truncate(site, 40)
  };
}

function previewJson(v) {
  try { return JSON.parse(decodeBufferText(v.buf, v.contentType)); } catch (e) { return null; }
}

/** fetch 한 번. 시간 제한과 (새 요청이 들어오면) 바깥 abort를 함께 지킨다. */
function requestRaw(url, ms, opts) {
  var o = opts || {};
  return new Promise(function (resolve, reject) {
    if (o.signal && o.signal.aborted) { reject(new Error('aborted')); return; }
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var done = false;

    function finish(err, val) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (o.signal) { try { o.signal.removeEventListener('abort', onAbort); } catch (e) { /* noop */ } }
      if (err) reject(err); else resolve(val);
    }
    function onAbort() { if (ctrl) { try { ctrl.abort(); } catch (e) { /* noop */ } } finish(new Error('aborted')); }

    var timer = setTimeout(function () {
      if (ctrl) { try { ctrl.abort(); } catch (e) { /* noop */ } }
      finish(new Error('timeout'));
    }, ms);
    if (o.signal) o.signal.addEventListener('abort', onAbort);

    fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      signal: ctrl ? ctrl.signal : undefined,
      headers: o.headers || undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      var ct = r.headers.get('content-type') || '';
      return r.arrayBuffer().then(function (buf) {
        return { buf: buf, contentType: ct, status: r.status };
      });
    }).then(function (v) { finish(null, v); }).catch(function (e) { finish(e); });
  });
}

/** 받은 값이 쓸 만한지 다듬어 표준 모양 {title, desc, thumb, site}로 돌려준다. */
function finalizePreview(res, pageUrl) {
  if (!res) return null;
  var title = cleanPreviewTitle(res.title, res.site || '');
  if (!title) return null;
  if (title.length < 60 && PREVIEW_JUNK_TITLE.test(title)) return null;
  return {
    title: truncate(title, 160),
    desc: truncate(cleanPreviewDesc(res.desc), 300),
    thumb: resolvePreviewImage(res.thumb, pageUrl),
    site: truncate(cleanPreviewTitle(res.site, ''), 40)
  };
}

var PREVIEW_YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{6,})/i;

/** URL에 맞는 시도 순서. 각 단계는 스스로 시간을 끊고, 실패하면 다음 단계로 넘어간다. */
function buildPreviewSteps(url) {
  if (PREVIEW_YT_RE.test(url)) {
    return [{
      label: 'youtube-oembed',
      timeout: 6000,
      url: function (u) { return 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(u); },
      parse: function (v) {
        var d = previewJson(v);
        if (!d || !d.title) return null;
        return { title: d.title, desc: d.author_name || '', thumb: d.thumbnail_url || '', site: 'YouTube' };
      }
    }];
  }

  return [
    {
      label: 'cors.eu.org',
      timeout: 7000,
      html: true,
      url: function (u) { return 'https://cors.eu.org/' + u; }
    },
    {
      label: 'jina-html',
      timeout: 9000,
      html: true,
      headers: { 'X-Return-Format': 'html' },
      url: function (u) { return 'https://r.jina.ai/' + u; }
    },
    {
      label: 'allorigins',
      timeout: 3500,
      html: true,
      url: function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); }
    },
    {
      label: 'codetabs',
      timeout: 3000,
      html: true,
      url: function (u) { return 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u); }
    },
    {
      label: 'microlink',
      timeout: 13000,
      url: function (u) { return 'https://api.microlink.io/?url=' + encodeURIComponent(u) + '&meta=true'; },
      parse: function (v) {
        var j = previewJson(v);
        if (!j || j.status !== 'success' || !j.data) return null;
        var d = j.data;
        return {
          title: d.title || '',
          desc: d.description || '',
          thumb: (d.image && d.image.url) || '',
          site: d.publisher || d.siteName || ''
        };
      }
    },
    {
      label: 'noembed',
      timeout: 4000,
      url: function (u) { return 'https://noembed.com/embed?url=' + encodeURIComponent(u); },
      parse: function (v) {
        var d = previewJson(v);
        if (!d || d.error) return null;
        return { title: d.title || '', desc: d.author_name || '', thumb: d.thumbnail_url || '', site: d.provider_name || '' };
      }
    }
  ];
}

function runPreviewSteps(steps, url, signal, deadline) {
  var i = 0;
  function next() {
    if (i >= steps.length) return Promise.resolve(null);
    if (signal && signal.aborted) return Promise.resolve(null);
    var remain = deadline - Date.now();
    if (remain < 1200) return Promise.resolve(null);
    var step = steps[i++];
    return requestRaw(step.url(url), Math.min(step.timeout, remain), { headers: step.headers, signal: signal })
      .then(function (v) {
        var res = step.html
          ? parseMetaFromHTML(decodeBufferText(v.buf, v.contentType), url)
          : step.parse(v);
        var fixed = finalizePreview(res, url);
        return fixed ? fixed : next();
      })
      .catch(function () { return next(); });
  }
  return next();
}

function previewCacheAll() {
  try {
    var raw = localStorage.getItem(PREVIEW_CACHE_KEY);
    if (!raw) return {};
    var obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { return {}; }
}

function readPreviewCache(url) {
  var hit = previewCacheAll()[url];
  if (!hit || !hit.at || !hit.res || !hit.res.title) return null;
  if (Date.now() - hit.at > PREVIEW_CACHE_TTL) return null;
  return hit.res;
}

function writePreviewCache(url, res) {
  if (!url || !res || !res.title) return;
  try {
    var all = previewCacheAll();
    all[url] = {
      at: Date.now(),
      res: { title: res.title, desc: res.desc || '', thumb: res.thumb || '', site: res.site || '' }
    };
    var keys = Object.keys(all);
    if (keys.length > PREVIEW_CACHE_MAX) {
      keys.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
      keys.slice(0, keys.length - PREVIEW_CACHE_MAX).forEach(function (k) { delete all[k]; });
    }
    localStorage.setItem(PREVIEW_CACHE_KEY, JSON.stringify(all));
  } catch (e) { /* 저장 공간이 없으면 캐시는 포기하고 매번 새로 받는다 */ }
}

var previewSeq = 0;

function applyPreviewToForm(res, url) {
  state.addPreview = res;
  state.addPreviewFor = url;
  showPreview(res);
  ui.previewHint.textContent = '제목·메모는 직접 고쳐도 돼요.';
  if (!ui.addTitleInput.value.trim() && res.title) ui.addTitleInput.value = truncate(res.title, 120);
  if (!ui.addMemo.value.trim() && res.desc) {
    ui.addMemo.value = truncate(oneLine(res.desc, 200), 200);
    updateMemoCount();
  }
}

function fetchPreviewInto(n) {
  var seq = ++previewSeq;
  if (previewAbort) { try { previewAbort.abort(); } catch (e) { /* noop */ } }
  previewAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var signal = previewAbort ? previewAbort.signal : undefined;
  var url = n.url;

  var cached = readPreviewCache(url);
  if (cached) { applyPreviewToForm(cached, url); return; }

  showPreview(null, true);
  var deadline = Date.now() + PREVIEW_BUDGET_MS;

  runPreviewSteps(buildPreviewSteps(url), url, signal, deadline).then(function (res) {
    if (seq !== previewSeq) return; // 더 새로운 요청이 있으면 무시
    if (!res) {
      hidePreview();
      ui.previewHint.textContent = '미리보기를 가져오지 못했어요. 제목을 직접 적어 주세요.';
      return;
    }
    writePreviewCache(url, res);
    applyPreviewToForm(res, url);
  }).catch(function () {
    if (seq !== previewSeq) return;
    hidePreview();
    ui.previewHint.textContent = '미리보기를 가져오지 못했어요. 제목을 직접 적어 주세요.';
  });
}

/* ---------------------------------------------------------------- clipboard */

function readClipboardText() {
  if (navigator.clipboard && navigator.clipboard.readText) {
    return navigator.clipboard.readText().catch(function () { return null; });
  }
  return Promise.resolve(null);
}

function pasteImageFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    toast('이 브라우저에서는 버튼 붙여넣기가 안 돼요. ⌘/Ctrl+V를 눌러 주세요.');
    return;
  }
  navigator.clipboard.read().then(function (items) {
    var jobs = [];
    (items || []).forEach(function (item) {
      (item.types || []).forEach(function (type) {
        if (!/^image\//.test(type)) return;
        jobs.push(item.getType(type).then(function (blob) {
          var ext = type.split('/')[1] || 'png';
          return new File([blob], 'paste-' + Date.now() + '.' + ext, { type: type });
        }));
      });
    });
    if (!jobs.length) {
      toast('클립보드에 이미지가 없어요. 스크린샷을 찍고 다시 시도해 주세요.');
      return;
    }
    Promise.all(jobs).then(function (files) {
      addFilesToAdd(files);
      toast(files.length + '장을 붙여넣었어요');
    });
  }).catch(function () {
    toast('붙여넣기 권한이 필요해요. 화면을 길게 눌러 붙여넣거나 ⌘/Ctrl+V를 눌러 주세요.');
  });
}

function pasteIntoUrl() {
  readClipboardText().then(function (text) {
    if (text === null) {
      toast('붙여넣기 권한이 필요해요. 입력칸을 길게 눌러 붙여넣어 주세요.');
      return;
    }
    var t = (text || '').trim();
    if (!t) {
      toast('클립보드에 글자가 없어요. 길게 눌러 직접 붙여넣어 주세요.');
      return;
    }
    var found = findUrl(t);
    if (found) {
      ui.addUrl.value = found.url;
      if (!ui.addTitleInput.value.trim() && t !== found.raw) {
        var rest = t.replace(found.raw, '').replace(/\s+/g, ' ').trim();
        if (rest && rest.length < 120) ui.addTitleInput.value = rest;
      }
      schedulePreview();
    } else {
      ui.addUrl.value = t;
      schedulePreview();
      toast('주소 형태가 아니어서 그대로 넣었어요');
    }
  });
}

/* -------------------------------------------------------------- image intake */

function addFilesToAdd(files) {
  var list = Array.prototype.slice.call(files || []).filter(function (f) {
    return f && /^image\//.test(f.type || '');
  }).slice(0, 12);
  if (!list.length) {
    toast('이미지 파일이 아니에요');
    return;
  }
  list.forEach(function (f) {
    state.addImages.push({ file: f, url: URL.createObjectURL(f) });
  });
  if (state.addType !== 'image') setAddType('image', false);
  renderImgStrip();
}

function renderImgStrip() {
  var html = '';
  if (state.addExistingThumb) {
    html += '<div class="thumb existing"><img src="' + esc(state.addExistingThumb) + '" alt=""><span class="tag" style="position:absolute;left:4px;bottom:4px">현재</span></div>';
  }
  state.addImages.forEach(function (entry, i) {
    html += '<div class="thumb"><img src="' + esc(entry.url) + '" alt="">' +
      '<button type="button" class="rm" data-rmimg="' + i + '" aria-label="이미지 빼기">' +
      '<svg class="ico"><use href="#i-close"/></svg></button></div>';
  });
  ui.imgStrip.innerHTML = html;
}

function packImage(file) {
  return decodeImage(file).then(function (decoded) {
    var width = decoded.width || decoded.naturalWidth || 0;
    if (!decoded || !width) throw new Error('decode');
    var full = scaleImage(decoded, MAX_IMAGE_WIDTH, 0.85, 0.80);
    return full.then(function (f) {
      return scaleImage(decoded, MAX_THUMB_WIDTH, 0.74, 0.68).then(function (t) {
        if (decoded.close) { try { decoded.close(); } catch (e) { /* noop */ } }
        if (decoded.__objectUrl) { try { URL.revokeObjectURL(decoded.__objectUrl); } catch (e) { /* noop */ } }
        if (!f.blob) throw new Error('encode');
        return { image: f.blob, thumb: t.blob, width: f.w, height: f.h, mime: f.blob.type || '' };
      });
    });
  }).catch(function () {
    return { image: file, thumb: null, width: 0, height: 0, mime: file.type || '' };
  });
}

function decodeImage(file) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      reject(new Error('timeout'));
    }, 12000);
    img.onload = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { img.__objectUrl = url; } catch (e) { /* noop */ }
      resolve(img);
    };
    img.onerror = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.decoding = 'async';
    img.src = url;
  });
}

function scaleImage(src, maxWidth, quality, qualityFallback) {
  var w = src.width || src.naturalWidth || 0;
  var h = src.height || src.naturalHeight || 0;
  var scale = Math.min(1, maxWidth / w);
  var cw = Math.max(1, Math.round(w * scale));
  var ch = Math.max(1, Math.round(h * scale));

  var canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  var ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve({ blob: null, w: cw, h: ch });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(src, 0, 0, cw, ch);

  function toBlob(type, q) {
    return new Promise(function (resolve) {
      try {
        canvas.toBlob(function (b) { resolve(b); }, type, q);
      } catch (e) { resolve(null); }
    });
  }

  return toBlob('image/webp', quality).then(function (blob) {
    if (blob && /webp/.test(blob.type || '')) return { blob: blob, w: cw, h: ch };
    return toBlob('image/jpeg', qualityFallback || quality).then(function (b2) {
      if (b2) return { blob: b2, w: cw, h: ch };
      return { blob: null, w: cw, h: ch };
    });
  });
}

/* =============================================================================
   Part 3b / 상세 보기 · 폴더 관리 · 설정 · 백업
   ============================================================================= */

function findItem(id) {
  for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
  return null;
}

function openDetail(id) {
  var item = findItem(id);
  if (!item) return;
  state.detailId = id;
  renderDetail(item);
  openSheet(ui.detailSheet);
}

function renderDetail(item) {
  if (!item) return;
  var folder = folderById(state.folders, item.folderId || 'inbox') || { name: '미분류', color: 'var(--ink-3)' };
  ui.btnFav.setAttribute('aria-pressed', item.favorite ? 'true' : 'false');

  var html = '';

  if (item.type === 'image' && item.image) {
    html += '<div class="detail-media" id="detailMedia">' +
      '<img id="detailImg" src="' + esc(blobUrl(item.image)) + '" alt="">' +
      '<span class="zoom-hint">두 번 탭하면 확대</span>' +
      '</div>';
  }

  if (item.type === 'link' && item.url) {
    var prevStyle = item.thumbnailUrl
      ? ' style="background-image:url(&quot;' + esc(String(item.thumbnailUrl).replace(/"/g, '%22')) + '&quot;)"'
      : '';
    html += '<a class="detail-link-card" href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">' +
      '<span class="prev"' + prevStyle + '>' + (item.thumbnailUrl ? '' : '🔗') + '</span>' +
      '<span class="lm"><b>' + esc(item.domain || domainOf(item.url)) + '</b>' +
      '<span>' + esc(truncate(item.url, 64)) + '</span></span>' +
      '<svg class="ico"><use href="#i-external"/></svg>' +
      '</a>';
  }

  var actions = '';
  var actBtn = function (act, label, icon, cls) {
    return '<button type="button" class="btn ' + cls + '" data-dact="' + act + '">' +
      '<svg class="ico"><use href="#' + icon + '"/></svg>' + label + '</button>';
  };

  if (item.type === 'link') {
    actions += '<a class="btn primary span2" href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">' +
      '<svg class="ico"><use href="#i-external"/></svg>링크 열기</a>';
    actions += actBtn('copy-link', '링크 복사', 'i-copy', 'ghost');
    actions += actBtn('copy-text', '내용 복사', 'i-note', 'ghost');
  } else if (item.type === 'image') {
    actions += actBtn('download', '이미지 저장', 'i-download', 'primary span2');
    actions += actBtn('copy-text', '내용 복사', 'i-copy', 'ghost');
    actions += actBtn('copy-fav', item.favorite ? '고정 해제' : '즐겨찾기', 'i-star', 'ghost');
  } else {
    actions += actBtn('copy-text', '전체 복사', 'i-copy', 'primary span2');
    actions += actBtn('copy-fav', item.favorite ? '고정 해제' : '즐겨찾기', 'i-star', 'ghost');
  }
  actions += actBtn('move', '폴더 이동', 'i-folder', 'ghost');

  var metaBits = [fullDate(item.createdAt) + ' 저장'];
  if (item.updatedAt && item.updatedAt - item.createdAt > 60000) metaBits.push(humanDate(item.updatedAt) + ' 수정');
  metaBits.push(folder.name);
  metaBits.push(TYPE_LABEL[item.type] || '메모');

  html += '<div class="detail-content">' +
    '<div class="detail-kicker">' + (TYPE_EMOJI[item.type] || '📝') + ' ' + esc(TYPE_LABEL[item.type] || '메모') +
      ' <span class="k-dot" style="width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.6"></span> ' + esc(folder.name) + '</div>' +
    '<h2 id="detailHeading">' + esc(itemTitle(item)) + '</h2>' +
    (item.memo ? '<p class="detail-memo">' + esc(item.memo) + '</p>' : '') +
    ((item.tags || []).length
      ? '<div class="detail-tags">' + item.tags.map(function (t) {
          return '<button type="button" class="tag" data-dact="tag" data-tag="' + esc(t) + '">#' + esc(t) + '</button>';
        }).join('') + '</div>'
      : '') +
    '<div class="detail-meta">' + esc(metaBits.join(' · ')) + '</div>' +
    '<div class="detail-actions">' + actions + '</div>' +
    '</div>';

  ui.detailBody.innerHTML = html;
  ui.detailBody.scrollTop = 0;
  if (item.type === 'image' && item.image) wireImageZoom();
}

function wireImageZoom() {
  var media = document.getElementById('detailMedia');
  var img = document.getElementById('detailImg');
  if (!media || !img) return;

  var scale = 1, tx = 0, ty = 0;
  var startDist = 0, startScale = 1, startTx = 0, startTy = 0, startX = 0, startY = 0;
  var dragging = false, lastTap = 0;

  function apply() {
    img.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(' + scale + ')';
    var zoomed = scale > 1.01;
    media.classList.toggle('zoomed', zoomed);
    media.style.touchAction = zoomed ? 'none' : 'pan-y';
  }
  function reset() { scale = 1; tx = 0; ty = 0; apply(); }
  function dist(touches) {
    var dx = touches[0].clientX - touches[1].clientX;
    var dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  media.addEventListener('dblclick', function (e) {
    e.preventDefault();
    if (scale > 1.01) reset();
    else { scale = 2.3; apply(); }
  });

  media.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      startDist = dist(e.touches);
      startScale = scale;
      dragging = false;
    } else if (e.touches.length === 1) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTx = tx;
      startTy = ty;
      dragging = scale > 1.01;
      var now = Date.now();
      if (now - lastTap < 320) {
        e.preventDefault();
        if (scale > 1.01) reset();
        else { scale = 2.3; apply(); }
        lastTap = 0;
      } else {
        lastTap = now;
      }
    }
  }, { passive: false });

  media.addEventListener('touchmove', function (e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      var d = dist(e.touches);
      if (!startDist) return;
      scale = clamp(startScale * (d / startDist), 1, 5);
      if (scale <= 1) { tx = 0; ty = 0; }
      apply();
    } else if (e.touches.length === 1 && dragging && scale > 1) {
      e.preventDefault();
      tx = startTx + (e.touches[0].clientX - startX);
      ty = startTy + (e.touches[0].clientY - startY);
      apply();
    }
  }, { passive: false });

  media.addEventListener('touchend', function (e) {
    if (!e.touches.length) {
      startDist = 0;
      dragging = false;
      if (scale <= 1.02) reset();
    }
  });
}

function closeDetailIfOpen() {
  if (ui.detailSheet.classList.contains('open')) {
    closeSheet(ui.detailSheet);
    state.detailId = null;
  }
}

function deleteItem(id, silent) {
  var item = removeItemEverywhere(id);
  if (!item) return;
  dbDelete('items', id).catch(function () { toast('삭제를 저장하지 못했어요'); });
  if (state.selected.has(id)) { state.selected.delete(id); }
  if (state.detailId === id) closeDetailIfOpen();
  render();
  if (!silent) {
    toast('삭제했어요', {
      action: '실행취소',
      onAction: function () {
        state.items.push(item);
        dbPut('items', item).then(render).catch(function () { toast('되돌리지 못했어요'); });
        render();
        toast('되돌렸어요');
      }
    });
  }
}

function downloadBlob(filename, blobOrText, mime) {
  try {
    var blob = (blobOrText instanceof Blob) ? blobOrText : new Blob([blobOrText], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 5000);
  } catch (e) {
    toast('파일을 만들지 못했어요');
  }
}

function safeFileName(text, fallback) {
  var s = oneLine(text, 48).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (s || fallback || 'scrap');
}

function downloadImage(item) {
  if (!item || !item.image) return;
  var ext = /png/.test(item.mime || (item.image.type || '')) ? 'png' : (/webp/.test(item.mime || (item.image.type || '')) ? 'webp' : 'jpg');
  downloadBlob(safeFileName(itemTitle(item), 'scrap') + '.' + ext, item.image);
  toast('이미지를 내려받았어요');
}

function moveItems(ids, folderId) {
  var changed = [];
  state.items.forEach(function (it) {
    if (ids.indexOf(it.id) !== -1 && (it.folderId || 'inbox') !== folderId) {
      it.folderId = folderId;
      it.updatedAt = Date.now();
      changed.push(it);
    }
  });
  if (!changed.length) return Promise.resolve(0);
  return dbPutMany('items', changed).then(function () {
    render();
    return changed.length;
  });
}

function askMoveTarget(ids) {
  if (!ids || !ids.length) return;
  var current = ids.length === 1 ? ((findItem(ids[0]) || {}).folderId || 'inbox') : '';
  var actions = sortFolders(state.folders).map(function (f) {
    return {
      label: (f.emoji || '📁') + '  ' + f.name + (f.id === current ? '  · 지금' : ''),
      value: f.id,
      style: 'ghost'
    };
  });
  actions.push({ label: '취소', value: null, style: 'ghost' });

  askConfirm({
    title: '폴더 이동',
    text: ids.length + '개 항목을 어디로 옮길까요?',
    actions: actions
  }).then(function (folderId) {
    if (!folderId) return;
    moveItems(ids, folderId).then(function (n) {
      var f = folderById(state.folders, folderId);
      if (n) toast(n + '개를 “' + ((f && f.name) || '폴더') + '”로 옮겼어요');
      if (state.detailId) {
        var it = findItem(state.detailId);
        if (it) renderDetail(it);
      }
      if (state.selectMode) { state.selected.clear(); syncSelectionDOM(); }
    });
  });
}

/* ------------------------------------------------------------ folder sheet */

function openFolderSheet() {
  state.paletteFolderId = null;
  ui.palette.hidden = true;
  renderFolderList();
  openSheet(ui.folderSheet);
}

function renderFolderList() {
  var counts = countByFolder(state.items);
  var list = sortFolders(state.folders);
  ui.folderList.innerHTML = list.map(function (f, i) {
    return '<div class="folder-row" data-fid="' + esc(f.id) + '">' +
      '<button type="button" class="badge-btn" data-palette="' + esc(f.id) + '" aria-label="아이콘 바꾸기">' +
        esc(f.emoji || '📁') +
      '</button>' +
      '<input class="fname" type="text" value="' + esc(f.name) + '" data-rename="' + esc(f.id) + '"' +
        ' maxlength="20" enterkeyhint="done"' + (f.system ? ' readonly' : '') + ' aria-label="폴더 이름">' +
      '<span class="fcount">' + (counts[f.id] || 0) + '</span>' +
      '<div class="reorder">' +
        '<button type="button" class="mini-btn" data-up="' + esc(f.id) + '"' + (f.system || i === 0 ? ' disabled' : '') + ' aria-label="위로">' +
          '<svg class="ico"><use href="#i-up"/></svg></button>' +
        '<button type="button" class="mini-btn" data-down="' + esc(f.id) + '"' + (f.system || i === list.length - 1 ? ' disabled' : '') + ' aria-label="아래로">' +
          '<svg class="ico"><use href="#i-down"/></svg></button>' +
        '<button type="button" class="mini-btn danger" data-delfolder="' + esc(f.id) + '"' + (f.system ? ' disabled' : '') + ' aria-label="삭제">' +
          '<svg class="ico"><use href="#i-trash"/></svg></button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function saveFolder(folder) {
  var exists = false;
  state.folders.forEach(function (f, i) {
    if (f.id === folder.id) { state.folders[i] = folder; exists = true; }
  });
  if (!exists) state.folders.push(folder);
  return dbPut('folders', folder);
}

function openPalette(folderId) {
  var f = folderById(state.folders, folderId);
  if (!f) return;
  state.paletteFolderId = folderId;
  ui.palette.hidden = false;
  ui.paletteEmojis.innerHTML = EMOJI_CHOICES.map(function (e) {
    return '<button type="button" class="' + (e === f.emoji ? 'on' : '') + '" data-emoji="' + esc(e) + '">' + e + '</button>';
  }).join('');
  ui.paletteColors.innerHTML = COLOR_CHOICES.map(function (c) {
    return '<button type="button" class="' + (c === f.color ? 'on' : '') + '" data-color="' + esc(c) + '"' +
      ' style="background:' + esc(c) + '" aria-label="' + esc(c) + '"></button>';
  }).join('');
  setTimeout(function () {
    try { ui.palette.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* noop */ }
  }, 40);
}

function askDeleteFolder(id) {
  var f = folderById(state.folders, id);
  if (!f || f.system) return;
  var n = countByFolder(state.items)[id] || 0;

  askConfirm({
    title: '“' + f.name + '” 폴더 삭제',
    text: n
      ? '이 폴더에 ' + n + '개 항목이 있어요. 미분류로 옮기고 폴더만 지우거나, 항목까지 함께 지울 수 있어요.'
      : '빈 폴더예요. 지울까요?',
    actions: n ? [
      { label: '미분류로 옮기고 삭제', value: 'move', style: 'primary' },
      { label: '항목까지 함께 삭제', value: 'purge', style: 'danger' },
      { label: '취소', value: null, style: 'ghost' }
    ] : [
      { label: '삭제', value: 'purge', style: 'danger' },
      { label: '취소', value: null, style: 'ghost' }
    ]
  }).then(function (choice) {
    if (!choice) return;
    var ids = state.items.filter(function (it) { return (it.folderId || 'inbox') === id; }).map(function (it) { return it.id; });

    var work;
    if (choice === 'move') {
      work = moveItems(ids, 'inbox');
    } else {
      state.items = state.items.filter(function (it) { return (it.folderId || 'inbox') !== id; });
      work = Promise.all(ids.map(function (itemId) { return dbDelete('items', itemId).catch(function () { return null; }); }));
    }

    work.then(function () {
      state.folders = state.folders.filter(function (x) { return x.id !== id; });
      if (state.folderId === id) state.folderId = 'all';
      return dbDelete('folders', id);
    }).then(function () {
      if (state.paletteFolderId === id) { state.paletteFolderId = null; ui.palette.hidden = true; }
      renderFolderList();
      render();
      toast(choice === 'move' ? '폴더를 지우고 항목은 미분류로 옮겼어요' : '폴더를 지웠어요');
    });
  });
}

function addFolderFromInput() {
  var raw = ui.newFolderName.value.trim();
  if (!raw) { try { ui.newFolderName.focus(); } catch (e) { /* noop */ } return; }
  var name = ensureUniqueFolderName(state.folders, raw);
  var maxOrder = 0;
  state.folders.forEach(function (f) {
    if (!f.system) maxOrder = Math.max(maxOrder, num(f.order, 0) + 1);
  });
  var folder = {
    id: uid('fd'),
    name: name,
    emoji: '📁',
    color: COLOR_CHOICES[state.folders.length % COLOR_CHOICES.length],
    order: maxOrder
  };
  saveFolder(folder).then(function () {
    ui.newFolderName.value = '';
    state.folders = sortFolders(state.folders);
    renderFolderList();
    render();
    toast('“' + name + '” 폴더를 만들었어요');
  });
}

/* ---------------------------------------------------------------- settings */

function openSettings() {
  applyTheme();
  Array.prototype.forEach.call(ui.viewSeg.querySelectorAll('button'), function (b) {
    var on = b.getAttribute('data-view-opt') === state.view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  ui.previewToggle.setAttribute('aria-checked', settings.preview ? 'true' : 'false');
  renderStats();
  openSheet(ui.settingsSheet);
}

function setTheme(theme) {
  saveSettings({ theme: theme });
  applyTheme();
}

function setView(view) {
  state.view = view === 'list' ? 'list' : 'card';
  saveSettings({ view: state.view });
  render();
  Array.prototype.forEach.call(ui.viewSeg.querySelectorAll('button'), function (b) {
    var on = b.getAttribute('data-view-opt') === state.view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

/* ---------------------------------------------------------------- backup */

function blobToDataURL(blob) {
  return new Promise(function (resolve) {
    if (!blob) return resolve('');
    try {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { resolve(''); };
      reader.readAsDataURL(blob);
    } catch (e) { resolve(''); }
  });
}

function dataURLToBlob(dataUrl) {
  try {
    var parts = String(dataUrl).split(',');
    if (parts.length < 2) return null;
    var m = parts[0].match(/data:([^;]+);base64/);
    var mime = m ? m[1] : 'application/octet-stream';
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch (e) {
    return null;
  }
}

function exportBackup() {
  if (!state.items.length) {
    toast('아직 내보낼 스크랩이 없어요');
    return;
  }
  var btn = ui.btnExport;
  if (btn) btn.disabled = true;
  toast('백업 파일을 만드는 중…');

  var outItems = [];
  var i = 0;

  function next() {
    if (i >= state.items.length) return done();
    var src = state.items[i++];
    var copy = {};
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      if (k === 'image' || k === 'thumb') continue;
      copy[k] = src[k];
    }
    var jobs = [];
    if (src.image) {
      jobs.push(blobToDataURL(src.image).then(function (d) {
        copy.image = d;
        copy.imageMime = (src.mime || (src.image && src.image.type) || '');
      }));
    }
    if (src.thumb) {
      jobs.push(blobToDataURL(src.thumb).then(function (d) { copy.thumb = d; }));
    }
    return Promise.all(jobs).then(function () {
      outItems.push(copy);
      return next();
    });
  }

  function done() {
    var payload = {
      app: APP_ID,
      version: BACKUP_VERSION,
      appName: '스크랩박스',
      exportedAt: new Date().toISOString(),
      folders: sortFolders(state.folders),
      items: outItems
    };
    var stamp = new Date();
    var ymd = stamp.getFullYear() + '-' + pad2(stamp.getMonth() + 1) + '-' + pad2(stamp.getDate());
    downloadBlob('스크랩박스-백업-' + ymd + '.json', JSON.stringify(payload, null, 2), 'application/json');
    if (btn) btn.disabled = false;
    toast(state.items.length + '개 항목을 백업 파일로 내려받았어요');
  }

  next();
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function importBackupFile(file) {
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var data;
    try {
      data = JSON.parse(String(reader.result || ''));
    } catch (e) {
      toast('JSON 파일을 읽지 못했어요. 백업 파일이 맞는지 확인해 주세요.');
      return;
    }
    var payload;
    try {
      payload = validateBackup(data);
    } catch (err) {
      toast(err.message || '백업 파일 형식이 아니에요');
      return;
    }
    if (!payload.items.length) {
      toast('복원할 항목이 없어요');
      return;
    }

    askConfirm({
      title: '복원하기',
      text: payload.items.length + '개 항목, ' + payload.folders.length + '개 폴더를 찾았어요. 기존 스크랩과 합칠까요, 아니면 이 백업으로 바꿀까요?' +
        (payload.warnings.length ? '\n형식이 맞지 않는 항목 ' + payload.warnings.length + '개는 건너뜁니다.' : ''),
      actions: [
        { label: '추가로 합치기', value: 'merge', style: 'primary' },
        { label: '전부 바꾸기', value: 'replace', style: 'danger' },
        { label: '취소', value: null, style: 'ghost' }
      ]
    }).then(function (mode) {
      if (!mode) return;
      restoreBackup(payload, mode);
    });
  };
  reader.onerror = function () { toast('파일을 읽지 못했어요'); };
  reader.readAsText(file);
}

function restoreBackup(payload, mode) {
  var replace = mode === 'replace';
  toast('복원하는 중…');

  var folders = replace ? [] : state.folders.slice();
  var folderIds = {};
  folders.forEach(function (f) { folderIds[f.id] = 1; });
  payload.folders.forEach(function (f) {
    if (!folderIds[f.id]) { folders.push(f); folderIds[f.id] = 1; }
  });
  folders = ensureBaseFolders(folders);

  var existingIds = {};
  if (!replace) state.items.forEach(function (it) { existingIds[it.id] = 1; });

  var incoming = payload.items.filter(function (it) {
    if (!folderIds[it.folderId] && it.folderId !== 'inbox') it.folderId = 'inbox';
    return !existingIds[it.id];
  });

  var converted = [];
  var idx = 0;

  function convertNext() {
    if (idx >= incoming.length) return finish();
    var it = incoming[idx++];
    var img = it.image;
    var th = it.thumb;
    var blob = null;
    var thumbBlob = null;
    if (typeof img === 'string' && img.indexOf('data:') === 0) blob = dataURLToBlob(img);
    if (typeof th === 'string' && th.indexOf('data:') === 0) thumbBlob = dataURLToBlob(th);
    if (blob) {
      converted.push(Object.assign({}, it, {
        image: blob,
        thumb: thumbBlob,
        mime: it.imageMime || (blob && blob.type) || ''
      }));
    } else if (thumbBlob) {
      converted.push(Object.assign({}, it, { image: null, thumb: thumbBlob }));
    } else {
      converted.push(Object.assign({}, it, { image: null, thumb: null }));
    }
    return Promise.resolve().then(convertNext);
  }

  function finish() {
    var newFolders = replace ? folders : folders.filter(function (f) {
      return !folderById(state.folders, f.id);
    });

    var work = replace
      ? Promise.all([dbClear('items'), dbClear('folders')])
        .then(function () { return dbPutMany('folders', folders); })
        .then(function () { return dbPutMany('items', converted); })
      : dbPutMany('folders', newFolders).then(function () { return dbPutMany('items', converted); });

    work.then(function () {
      state.folders = sortFolders(folders);
      state.items = replace ? converted.slice() : state.items.concat(converted);
      render();
      renderFolderList();
      toast(converted.length + '개 항목을 복원했어요');
    }).catch(function (err) {
      toast('복원에 실패했어요: ' + ((err && err.message) || ''));
    });
  }

  convertNext();
}

/* =============================================================================
   Part 3c / 이벤트 · 딥링크 · 시작
   ============================================================================= */

function onScroll() {
  if (!ui.topbar) return;
  ui.topbar.classList.toggle('is-scrolled', window.scrollY > 4);
}

function setFolder(id) {
  if (!id) return;
  state.folderId = id;
  state.selected.clear();
  state.selectMode = false;
  state.query = '';
  ui.searchInput.value = '';
  render();
  if (window.scrollY > 120) {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  }
}

/** 상단 한 줄 입력: 주소면 링크로, 아니면 메모로 바로 저장한다. */
function saveQuickCapture() {
  var raw = ui.quickInput.value;
  var text = String(raw || '').trim();
  if (!text) {
    try { ui.quickInput.focus(); } catch (e) { /* noop */ }
    return;
  }

  var folder = (state.folderId !== 'all' && state.folderId !== 'fav' && folderById(state.folders, state.folderId))
    ? state.folderId : 'inbox';
  var folderName = (folderById(state.folders, folder) || {}).name || '미분류';
  var now = Date.now();
  var link = normalizeUrl(text);
  var item;

  if (link.ok) {
    var found = findUrl(text);
    var rest = found ? text.replace(found.raw, ' ').replace(/\s+/g, ' ').trim() : '';
    item = {
      id: uid('it'), type: 'link', url: link.url, domain: link.domain, title: '',
      memo: rest,
      folderId: folder, tags: [], favorite: false,
      createdAt: now, updatedAt: now, thumbnailUrl: '', description: '', siteName: ''
    };
  } else {
    item = {
      id: uid('it'), type: 'memo', title: '', memo: text,
      folderId: folder, tags: [], favorite: false,
      createdAt: now, updatedAt: now, url: '', domain: ''
    };
  }

  ui.quickInput.value = '';
  ui.quickInput.blur();

  var stillVisible = inFolder(item, state.folderId) && (state.type === 'all' || state.type === item.type);
  if (!stillVisible) {
    if (state.type !== 'all' && state.type !== item.type) state.type = 'all';
    if (state.folderId !== 'all' && !inFolder(item, state.folderId)) {
      state.folderId = 'all';
      ui.searchInput.value = '';
      state.query = '';
    }
  }

  upsertItem(item).then(function () {
    render();
    toast((item.type === 'link' ? '링크를 ' : '메모를 ') + folderName + '에 담았어요');
    if (window.scrollY > 80) {
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { /* noop */ }
    }
  }).catch(function () { /* 토스트는 upsertItem에서 */ });
}

function setType(type) {
  state.type = (type === 'link' || type === 'image' || type === 'memo') ? type : 'all';
  state.selected.clear();
  render();
}

function toggleSelectMode(force) {
  state.selectMode = typeof force === 'boolean' ? force : !state.selectMode;
  state.selected.clear();
  render();
}

function togglePick(id) {
  if (!id) return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  syncSelectionDOM();
}

function handleEmptyAction(act) {
  if (act === 'add') openAdd({ type: 'link' });
  else if (act === 'clear-search') {
    ui.searchInput.value = '';
    state.query = '';
    render();
  } else if (act === 'show-all-type') {
    state.type = 'all';
    render();
  }
}

function onItemAreaClick(e) {
  var act = e.target.closest('[data-act]');
  if (act) { handleEmptyAction(act.getAttribute('data-act')); return; }
  var card = e.target.closest('.card');
  if (!card) return;
  var id = card.getAttribute('data-id');
  if (state.selectMode) { togglePick(id); return; }
  openDetail(id);
}

function isTypingTarget(el) {
  if (!el) return false;
  var tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

function copyBundle() {
  if (!state.visible.length) { toast('복사할 항목이 없어요'); return; }
  var folder = currentFolder();
  var name = folder.id === 'all' ? '전체' : (folder.id === 'fav' ? '즐겨찾기' : folder.name);
  var text = formatBundle(state.visible, name);
  copyText(text).then(function (ok) {
    toast(ok ? state.visible.length + '개를 복사했어요. 카톡에 붙여넣으세요' : '복사하지 못했어요');
  });
}

function copySelected() {
  var ids = Array.from(state.selected);
  if (!ids.length) return;
  var items = sortItems(state.items.filter(function (it) { return ids.indexOf(it.id) !== -1; }));
  copyText(formatBundle(items, '선택한 스크랩')).then(function (ok) {
    toast(ok ? items.length + '개를 복사했어요' : '복사하지 못했어요');
  });
}

function deleteSelected() {
  var ids = Array.from(state.selected);
  if (!ids.length) return;
  askConfirm({
    title: '삭제',
    text: ids.length + '개 항목을 지울까요? 지운 항목은 되돌릴 수 없어요.',
    actions: [
      { label: '삭제', value: true, style: 'danger' },
      { label: '취소', value: null, style: 'ghost' }
    ]
  }).then(function (v) {
    if (!v) return;
    ids.forEach(function (id) { deleteItem(id, true); });
    state.selected.clear();
    state.selectMode = false;
    render();
    toast(ids.length + '개를 지웠어요');
  });
}

function flipSwitch(el) {
  var on = el.getAttribute('aria-checked') === 'true';
  el.setAttribute('aria-checked', on ? 'false' : 'true');
  return !on;
}

function reorderFolder(id, dir) {
  state.folders = moveFolder(state.folders, id, dir);
  dbPutMany('folders', state.folders).then(function () {
    renderFolderList();
    render();
  }).catch(function () { toast('순서를 저장하지 못했어요'); });
}

function onFolderRename(e) {
  var input = e.target.closest('[data-rename]');
  if (!input) return;
  var id = input.getAttribute('data-rename');
  var folder = folderById(state.folders, id);
  if (!folder) return;
  var name = ensureUniqueFolderName(state.folders, input.value, id);
  if (name === folder.name) { input.value = folder.name; return; }
  folder.name = name;
  input.value = name;
  saveFolder(folder).then(function () {
    render();
    renderFolderList();
    toast('폴더 이름을 “' + name + '”로 바꿨어요');
  });
}

/* --------------------------------------------------------------- deep link */

function handleDeepLink() {
  var parsed = null;
  try { parsed = parseQueryParams(window.location.search); } catch (e) { parsed = null; }
  if (!parsed) return false;

  var folderId = '';
  if (parsed.folder) {
    var byId = folderById(state.folders, parsed.folder);
    var byName = null;
    state.folders.forEach(function (f) { if (!byName && f.name === parsed.folder) byName = f; });
    folderId = (byId && byId.id) || (byName && byName.id) || '';
  }

  openAdd({
    type: parsed.type,
    url: parsed.url,
    title: parsed.title,
    memo: parsed.memo,
    folderId: folderId
  });

  try {
    window.history.replaceState(null, '', window.location.pathname + (window.location.hash || ''));
  } catch (e) { /* file:// 등 */ }
  return true;
}

/* ------------------------------------------------------------------ events */

function wireEvents() {
  window.addEventListener('scroll', onScroll, { passive: true });

  ui.folderBar.addEventListener('click', function (e) {
    if (e.target.closest('[data-folder-manage]')) { openFolderSheet(); return; }
    var chip = e.target.closest('[data-folder]');
    if (chip) setFolder(chip.getAttribute('data-folder'));
  });

  ui.searchInput.addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    var value = ui.searchInput.value;
    ui.searchClear.hidden = !value;
    searchTimer = setTimeout(function () {
      state.query = value.trim();
      render();
    }, 140);
  });

  ui.searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      ui.searchInput.value = '';
      state.query = '';
      render();
      ui.searchInput.blur();
    }
  });

  ui.quickCapture.addEventListener('submit', function (e) {
    e.preventDefault();
    saveQuickCapture();
  });

  ui.searchClear.addEventListener('click', function () {
    ui.searchInput.value = '';
    state.query = '';
    render();
    try { ui.searchInput.focus(); } catch (e) { /* noop */ }
  });

  ui.typeSeg.addEventListener('click', function (e) {
    var b = e.target.closest('[data-type]');
    if (b) setType(b.getAttribute('data-type'));
  });

  ui.btnView.addEventListener('click', function () {
    setView(state.view === 'card' ? 'list' : 'card');
  });

  ui.btnBundle.addEventListener('click', copyBundle);
  ui.btnSelect.addEventListener('click', function () { toggleSelectMode(); });
  ui.fab.addEventListener('click', function () { openAdd({ type: 'link' }); });
  ui.btnQuickAdd.addEventListener('click', function () { openAdd({ type: 'link' }); });

  ui.itemArea.addEventListener('click', onItemAreaClick);
  ui.itemArea.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    onItemAreaClick(e);
  });

  ui.selCancel.addEventListener('click', function () { toggleSelectMode(false); });
  ui.selCopy.addEventListener('click', copySelected);
  ui.selMove.addEventListener('click', function () {
    if (state.selected.size) askMoveTarget(Array.from(state.selected));
  });
  ui.selDelete.addEventListener('click', deleteSelected);

  document.addEventListener('click', function (e) {
    var closer = e.target.closest('[data-close]');
    if (!closer) return;
    var sheet = closer.closest('.sheet');
    if (!sheet) return;
    if (sheet === ui.confirmSheet) { resolveConfirm(null); return; }
    if (sheet === ui.detailSheet) state.detailId = null;
    closeSheet(sheet);
  });

  ui.confirmActions.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ci]');
    if (!b) return;
    var i = Number(b.getAttribute('data-ci'));
    var action = confirmValues[i] || null;
    resolveConfirm(action ? (action.value === undefined ? null : action.value) : null);
  });

  /* ---- add sheet ---- */
  ui.addTypeSeg.addEventListener('click', function (e) {
    var b = e.target.closest('[data-addtype]');
    if (!b || b.disabled) return;
    setAddType(b.getAttribute('data-addtype'), true);
  });

  ui.addUrl.addEventListener('input', schedulePreview);
  ui.addUrl.addEventListener('blur', function () {
    if (ui.addUrl.value.trim()) schedulePreview();
  });
  ui.btnPasteUrl.addEventListener('click', pasteIntoUrl);
  ui.btnPreviewClear.addEventListener('click', function () {
    state.addPreview = null;
    state.addPreviewFor = '';
    hidePreview();
  });

  ui.btnPickImage.addEventListener('click', function () { ui.fileInput.click(); });
  ui.btnPasteImage.addEventListener('click', pasteImageFromClipboard);
  ui.fileInput.addEventListener('change', function () {
    if (ui.fileInput.files && ui.fileInput.files.length) addFilesToAdd(ui.fileInput.files);
    ui.fileInput.value = '';
  });

  ui.imgStrip.addEventListener('click', function (e) {
    var rm = e.target.closest('[data-rmimg]');
    if (!rm) return;
    var i = Number(rm.getAttribute('data-rmimg'));
    var entry = state.addImages.splice(i, 1)[0];
    if (entry) { try { URL.revokeObjectURL(entry.url); } catch (err) { /* noop */ } }
    renderImgStrip();
  });

  ui.addMemo.addEventListener('input', updateMemoCount);
  ui.addFav.addEventListener('click', function () { flipSwitch(ui.addFav); });
  ui.addFolderChips.addEventListener('click', function (e) {
    var c = e.target.closest('[data-addfolder]');
    if (!c) return;
    state.addFolderId = c.getAttribute('data-addfolder');
    renderAddFolderChips();
  });
  ui.btnSave.addEventListener('click', function () { saveAdd(); });
  ui.addSheet.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveAdd(); }
  });

  /* ---- detail ---- */
  ui.detailBody.addEventListener('click', function (e) {
    var b = e.target.closest('[data-dact]');
    if (!b) return;
    var item = findItem(state.detailId);
    if (!item) return;
    var act = b.getAttribute('data-dact');

    if (act === 'copy-link') {
      copyText(item.url).then(function (ok) { toast(ok ? '링크를 복사했어요' : '복사하지 못했어요'); });
    } else if (act === 'copy-text') {
      copyText(itemShareText(item)).then(function (ok) { toast(ok ? '내용을 복사했어요' : '복사하지 못했어요'); });
    } else if (act === 'copy-fav') {
      toggleFavorite(item.id);
      renderDetail(findItem(item.id));
    } else if (act === 'download') {
      downloadImage(item);
    } else if (act === 'move') {
      askMoveTarget([item.id]);
    } else if (act === 'tag') {
      var tag = b.getAttribute('data-tag');
      state.detailId = null;
      closeSheet(ui.detailSheet);
      state.folderId = 'all';
      state.type = 'all';
      state.query = '#' + tag;
      ui.searchInput.value = '#' + tag;
      render();
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { /* noop */ }
      toast('#' + tag + ' 태그로 모아봤어요');
    }
  });

  ui.btnFav.addEventListener('click', function () {
    if (!state.detailId) return;
    var on = toggleFavorite(state.detailId);
    var item = findItem(state.detailId);
    if (item) renderDetail(item);
    toast(on ? '즐겨찾기에 고정했어요' : '고정을 풀었어요');
  });

  ui.btnEdit.addEventListener('click', function () {
    var item = findItem(state.detailId);
    if (!item) return;
    closeSheet(ui.detailSheet);
    openAdd({ item: item });
  });

  ui.btnItemDelete.addEventListener('click', function () {
    var item = findItem(state.detailId);
    if (!item) return;
    deleteItem(item.id);
  });

  /* ---- folder sheet ---- */
  ui.folderList.addEventListener('change', onFolderRename);
  ui.folderList.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches('.fname')) {
      e.preventDefault();
      e.target.blur();
    }
  });
  ui.folderList.addEventListener('click', function (e) {
    var pal = e.target.closest('[data-palette]');
    if (pal) { openPalette(pal.getAttribute('data-palette')); return; }
    var up = e.target.closest('[data-up]');
    if (up) { reorderFolder(up.getAttribute('data-up'), -1); return; }
    var down = e.target.closest('[data-down]');
    if (down) { reorderFolder(down.getAttribute('data-down'), 1); return; }
    var del = e.target.closest('[data-delfolder]');
    if (del) askDeleteFolder(del.getAttribute('data-delfolder'));
  });

  ui.paletteEmojis.addEventListener('click', function (e) {
    var b = e.target.closest('[data-emoji]');
    if (!b || !state.paletteFolderId) return;
    var f = folderById(state.folders, state.paletteFolderId);
    if (!f) return;
    f.emoji = b.getAttribute('data-emoji');
    saveFolder(f).then(function () {
      renderFolderList();
      render();
      openPalette(f.id);
    });
  });

  ui.paletteColors.addEventListener('click', function (e) {
    var b = e.target.closest('[data-color]');
    if (!b || !state.paletteFolderId) return;
    var f = folderById(state.folders, state.paletteFolderId);
    if (!f) return;
    f.color = b.getAttribute('data-color');
    saveFolder(f).then(function () {
      renderFolderList();
      render();
      openPalette(f.id);
    });
  });

  ui.btnAddFolder.addEventListener('click', addFolderFromInput);
  ui.newFolderName.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addFolderFromInput(); }
  });

  /* ---- settings ---- */
  ui.btnSettings.addEventListener('click', openSettings);
  ui.themeSeg.addEventListener('click', function (e) {
    var b = e.target.closest('[data-theme-opt]');
    if (b) setTheme(b.getAttribute('data-theme-opt'));
  });
  ui.viewSeg.addEventListener('click', function (e) {
    var b = e.target.closest('[data-view-opt]');
    if (b) setView(b.getAttribute('data-view-opt'));
  });
  ui.previewToggle.addEventListener('click', function () {
    var on = flipSwitch(ui.previewToggle);
    saveSettings({ preview: on });
    toast(on ? '링크 미리보기를 자동으로 가져와요' : '링크 미리보기를 껐어요');
  });
  ui.btnExport.addEventListener('click', exportBackup);
  ui.btnImport.addEventListener('click', function () {
    ui.importInput.value = '';
    ui.importInput.click();
  });
  ui.importInput.addEventListener('change', function () {
    var file = ui.importInput.files && ui.importInput.files[0];
    if (file) importBackupFile(file);
  });

  /* ---- keyboard ---- */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (closeTopSheet()) { e.preventDefault(); }
      return;
    }
    if (isTypingTarget(e.target)) return;
    if ((e.metaKey || e.ctrlKey || e.altKey)) return;
    if (e.key === '/') {
      e.preventDefault();
      ui.searchInput.focus();
      ui.searchInput.select();
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      openAdd({ type: 'link' });
    }
  });

  /* ---- paste ---- */
  document.addEventListener('paste', function (e) {
    var cd = e.clipboardData;
    if (!cd) return;
    var items = cd.items ? Array.prototype.slice.call(cd.items) : [];
    var imageFiles = items.filter(function (it) {
      return it.kind === 'file' && /^image\//.test(it.type || '');
    }).map(function (it) { return it.getAsFile(); }).filter(Boolean);
    var text = '';
    try { text = cd.getData('text/plain') || ''; } catch (err) { text = ''; }
    var addOpen = ui.addSheet.classList.contains('open');

    if (imageFiles.length) {
      e.preventDefault();
      if (!addOpen) openAdd({ type: 'image' });
      else if (state.addType !== 'image') setAddType('image', false);
      addFilesToAdd(imageFiles);
      return;
    }

    if (addOpen && text.trim() && !state.editingId) {
      var whole = normalizeUrl(text);
      if (whole.ok && !ui.addUrl.value.trim()) {
        e.preventDefault();
        setAddType('link', false);
        ui.addUrl.value = whole.url;
        schedulePreview();
        toast('링크로 인식했어요');
        return;
      }
    }

    if (!addOpen && !isTypingTarget(e.target) && text.trim()) {
      var found = findUrl(text);
      e.preventDefault();
      if (found) {
        openAdd({ type: 'link', url: found.url, memo: text.replace(found.raw, '').trim() });
      } else {
        openAdd({ type: 'memo', memo: text.trim() });
      }
    }
  });

  /* ---- drag & drop (데스크톱) ---- */
  var overlay = document.createElement('div');
  overlay.className = 'drop-overlay';
  overlay.innerHTML = '<div>여기에 놓으면 담아요<small>링크는 링크로 · 이미지는 이미지로</small></div>';
  document.body.appendChild(overlay);
  var dragDepth = 0;

  window.addEventListener('dragenter', function (e) {
    if (!e.dataTransfer) return;
    dragDepth++;
    overlay.classList.add('on');
  });
  window.addEventListener('dragleave', function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.classList.remove('on');
  });
  window.addEventListener('dragover', function (e) {
    if (e.dataTransfer) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* noop */ }
    }
  });
  window.addEventListener('drop', function (e) {
    if (!e.dataTransfer) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove('on');
    var files = Array.prototype.slice.call(e.dataTransfer.files || []).filter(function (f) {
      return /^image\//.test(f.type || '');
    });
    if (files.length) {
      openAdd({ type: 'image' });
      addFilesToAdd(files);
      return;
    }
    var text = '';
    try { text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || ''; } catch (err) { text = ''; }
    var found = findUrl(text);
    if (found) openAdd({ type: 'link', url: found.url, memo: text.replace(found.raw, '').trim() });
    else if (text.trim()) openAdd({ type: 'memo', memo: text.trim() });
  });

  /* ---- theme follow ---- */
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function () { if (settings.theme === 'auto') applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
    else if (mq.addListener) mq.addListener(onScheme);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.ready) render();
  });
}

/* -------------------------------------------------------------------- boot */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () { /* 오프라인 캐시는 조용히 포기 */ });
  });
}

function boot() {
  cacheUI();
  loadSettings();
  applyTheme();
  wireEvents();
  registerServiceWorker();

  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { /* noop */ });
  } catch (e) { /* noop */ }

  openDB().then(function () {
    return Promise.all([dbAll('items'), dbAll('folders')]);
  }).then(function (res) {
    var items = res[0] || [];
    var folders = sortFolders(res[1] || []);

    if (!folders.length) {
      folders = DEFAULT_FOLDERS.map(function (f) { return Object.assign({}, f); });
      return dbPutMany('folders', folders).then(function () {
        return { items: items, folders: folders };
      });
    }
    var withBase = ensureBaseFolders(folders);
    if (withBase.length !== folders.length) {
      return dbPut('folders', withBase[0]).then(function () {
        return { items: items, folders: withBase };
      });
    }
    return { items: items, folders: folders };
  }).then(function (data) {
    var items = data.items || [];
    var folders = data.folders || [];

    var ids = {};
    folders.forEach(function (f) { ids[f.id] = 1; });
    var dirty = [];
    items.forEach(function (it) {
      if (!it.folderId || !ids[it.folderId]) {
        it.folderId = 'inbox';
        dirty.push(it);
      }
      if (!it.createdAt) it.createdAt = Date.now();
    });
    if (dirty.length) dbPutMany('items', dirty).catch(function () { /* noop */ });

    state.items = items;
    state.folders = folders;
    state.ready = true;
    render();
    handleDeepLink();
  }).catch(function (err) {
    state.ready = true;
    render();
    toast('저장소를 열지 못했어요. ' + ((err && err.message) || '') + ' 비공개 모드에서는 저장이 안 될 수 있어요.');
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
