// ============================================================
// Админ-панель. Как и клиентская часть, ничего не знает о конкретном
// салоне: название, мастера и услуги приходят с бэкенда (getConfig).
//
// Пароль в браузере не хранится дольше сессии вкладки и никогда не
// попадает в URL — он уходит только в теле POST-запроса.
//
// Адрес Cloud Function — тот же, что и в script-demo.js.
// ============================================================
var CLOUD_FUNCTION_URL = 'https://functions.yandexcloud.net/d4ebphtbsdd9noj2va0s';

function isBackendConfigured() {
  return typeof CLOUD_FUNCTION_URL === 'string'
    && CLOUD_FUNCTION_URL.length > 0
    && CLOUD_FUNCTION_URL.indexOf('ЗАМЕНИТЕ') === -1;
}

var LOGIN_KEY = 'demo_admin_login';
var PASSWORD_KEY = 'demo_admin_password';
var ACTIVITY_KEY = 'demo_admin_activity';

// Забытая открытой вкладка сама попросит пароль заново. Отсчёт идёт от
// последнего действия, поэтому активная работа не обрывается.
var SESSION_TIMEOUT_MS = 30 * 60 * 1000;

var CONFIG = null;
var cache = { bookings: [], history: [], clients: {}, lastSeenAt: null, schedule: null, scheduleDates: [] };

// ---------- Сессия ----------

function storedCreds() {
  return {
    login: sessionStorage.getItem(LOGIN_KEY) || '',
    password: sessionStorage.getItem(PASSWORD_KEY) || '',
  };
}

function touchActivity() {
  sessionStorage.setItem(ACTIVITY_KEY, String(Date.now()));
}

function isSessionExpired() {
  var last = parseInt(sessionStorage.getItem(ACTIVITY_KEY), 10);
  if (!last) return true;
  return (Date.now() - last) > SESSION_TIMEOUT_MS;
}

function clearSession() {
  sessionStorage.removeItem(LOGIN_KEY);
  sessionStorage.removeItem(PASSWORD_KEY);
  sessionStorage.removeItem(ACTIVITY_KEY);
}

function callAdmin(action, data) {
  touchActivity();
  var creds = storedCreds();
  var body = Object.assign({
    action: action,
    adminLogin: creds.login,
    adminPassword: creds.password,
  }, data || {});

  return fetch(CLOUD_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (res) {
    return res.json().then(function (json) { return { status: res.status, json: json }; });
  });
}

function callPublic(action, data) {
  return fetch(CLOUD_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action }, data || {})),
  }).then(function (res) { return res.json(); });
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function formatDateRu(iso) {
  var d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
}

function money(sum) {
  return Number(sum || 0).toLocaleString('ru-RU') + ' ₽';
}

// «1 визит», «2 визита», «5 визитов» — иначе аналитика читается коряво.
function plural(n, forms) {
  var abs = Math.abs(n) % 100;
  var last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

// ============================================================
// Запуск
// ============================================================

var loginScreen = document.getElementById('login-screen');
var adminApp = document.getElementById('admin-app');
var loginBtn = document.getElementById('login-btn');
var loginError = document.getElementById('login-error');
var loginInput = document.getElementById('admin-login-input');
var passwordInput = document.getElementById('admin-password-input');

document.addEventListener('DOMContentLoaded', function () {
  if (!isBackendConfigured()) {
    console.error('Не задан адрес Cloud Function: проверьте backend-url.js (переменная CLOUD_FUNCTION_URL).');
    showLoginError('Панель не подключена к серверу: в backend-url.js не указан адрес Cloud Function.');
    return;
  }

  callPublic('getConfig', {})
    .then(function (res) {
      CONFIG = (res && res.config) || null;
      applyConfig();
      // Живая сессия — сразу в панель, без повторного ввода пароля.
      var creds = storedCreds();
      if (creds.login && creds.password && !isSessionExpired()) showApp();
    })
    .catch(function (err) {
      console.error('Не удалось загрузить конфигурацию:', err);
      showLoginError('Сервер не отвечает. Обновите страницу позже.');
    });
});

function applyConfig() {
  if (!CONFIG) return;

  var colors = (CONFIG.brand && CONFIG.brand.colors) || {};
  Object.keys(colors).forEach(function (name) {
    document.documentElement.style.setProperty(name, colors[name]);
  });

  var salonName = (CONFIG.salon && CONFIG.salon.name) || '';
  document.title = 'Админ-панель' + (salonName ? ' — ' + salonName : '');
  document.getElementById('login-salon').textContent = salonName;
  document.getElementById('admin-title').textContent = 'Админ-панель' + (salonName ? ' · ' + salonName : '');

  if (CONFIG.demoMode && CONFIG.demo) {
    var notice = document.getElementById('demo-notice');
    if (CONFIG.demo.noticeText) {
      notice.textContent = CONFIG.demo.noticeText;
      notice.hidden = false;
    }
    var hint = document.getElementById('login-demo-hint');
    hint.innerHTML = 'Демо-доступ: логин <code>' + escapeHtml(CONFIG.demo.adminLogin || '')
      + '</code>, пароль <code>' + escapeHtml(CONFIG.demo.adminPassword || '') + '</code>.'
      + '<br>Смена пароля в демо-режиме отключена.';
    hint.hidden = false;
  }

  renderMasterSelect();
}

function showLoginError(text) {
  loginError.textContent = text;
  loginError.hidden = false;
}

function showApp() {
  loginScreen.hidden = true;
  adminApp.hidden = false;
  loadAll();
}

function showLoginScreen(message) {
  clearSession();
  adminApp.hidden = true;
  loginScreen.hidden = false;
  passwordInput.value = '';
  if (message) showLoginError(message);
}

loginBtn.addEventListener('click', function () {
  var login = loginInput.value.trim();
  var password = passwordInput.value.trim();
  if (!login || !password) return;

  loginError.hidden = true;
  loginBtn.disabled = true;

  sessionStorage.setItem(LOGIN_KEY, login);
  sessionStorage.setItem(PASSWORD_KEY, password);
  touchActivity();

  callAdmin('adminLogin', {})
    .then(function (r) {
      if (r.status === 200) { showApp(); return; }
      clearSession();
      showLoginError(r.status === 429
        ? 'Слишком много попыток — подождите несколько минут.'
        : 'Неверный логин или пароль.');
    })
    .catch(function () {
      clearSession();
      showLoginError('Сервер не отвечает. Попробуйте позже.');
    })
    .finally(function () { loginBtn.disabled = false; });
});

passwordInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') loginBtn.click(); });
loginInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') passwordInput.focus(); });

document.getElementById('logout-btn').addEventListener('click', function () {
  clearSession();
  location.reload();
});

// Единая обработка ответа: истёкшая сессия или смена пароля на сервере
// не должны оставлять панель с пустыми списками без объяснения.
function handleAuth(r) {
  if (r.status === 401) { showLoginScreen('Сессия завершена — войдите снова.'); return false; }
  if (r.status === 429) { showLoginScreen('Слишком много попыток — подождите несколько минут.'); return false; }
  return true;
}

// ---------- Вкладки ----------

document.querySelectorAll('.admin-tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var tab = btn.getAttribute('data-admin-tab');
    document.querySelectorAll('.admin-tab-btn').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.admin-panel').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    document.querySelector('.admin-panel[data-admin-panel="' + tab + '"]').classList.add('active');

    if (tab === 'bookings') markSeen();
    if (tab === 'analytics') renderAnalytics();
  });
});

// ---------- Загрузка данных ----------

function loadAll() {
  loadBookings();
  loadHistory();
  loadClients();
  loadSchedule();
}

document.getElementById('refresh-bookings-btn').addEventListener('click', loadBookings);

function loadBookings() {
  var list = document.getElementById('bookings-list');
  list.innerHTML = '<p class="a-hint">Загрузка…</p>';

  callAdmin('getBookings', {}).then(function (r) {
    if (!handleAuth(r)) return;
    cache.bookings = (r.json && r.json.bookings) || [];
    cache.lastSeenAt = (r.json && r.json.lastSeenAt) || null;
    renderBookings();
  }).catch(function () {
    list.innerHTML = '<p class="a-error">Не удалось загрузить записи.</p>';
  });
}

function loadHistory() {
  callAdmin('getHistory', {}).then(function (r) {
    if (!handleAuth(r)) return;
    cache.history = (r.json && r.json.history) || [];
    renderHistory();
  }).catch(function () {});
}

function loadClients() {
  callAdmin('getClients', {}).then(function (r) {
    if (!handleAuth(r)) return;
    cache.clients = (r.json && r.json.clients) || {};
    renderClients();
  }).catch(function () {});
}

function loadSchedule() {
  callAdmin('getSchedule', {}).then(function (r) {
    if (!handleAuth(r)) return;
    cache.schedule = (r.json && r.json.schedule) || {};
    cache.scheduleDates = (r.json && r.json.dates) || [];
    renderSchedule();
  }).catch(function () {});
}

// ============================================================
// Записи
// ============================================================

function isNewBooking(b) {
  if (!b.createdAt) return false;
  if (!cache.lastSeenAt) return true;
  return b.createdAt > cache.lastSeenAt;
}

function renderBookings() {
  var list = document.getElementById('bookings-list');
  var sorted = cache.bookings.slice().sort(function (a, b) {
    return (a.date + a.start) < (b.date + b.start) ? -1 : 1;
  });

  var newCount = sorted.filter(isNewBooking).length;
  var badge = document.getElementById('new-bookings-badge');
  badge.textContent = newCount;
  badge.hidden = newCount === 0;

  if (!sorted.length) {
    list.innerHTML = '<p class="a-hint">Предстоящих записей нет.</p>';
    return;
  }

  list.innerHTML = '';
  sorted.forEach(function (b) {
    var card = document.createElement('div');
    card.className = 'admin-card' + (isNewBooking(b) ? ' is-new' : '');

    var contacts = (b.contactMethods || []).map(function (id) {
      var found = CONFIG && CONFIG.contactMethods.find(function (c) { return c.id === id; });
      return found ? found.label : id;
    }).join(', ');

    card.innerHTML =
      '<div class="card-head">'
      + '<span class="card-when">' + escapeHtml(formatDateRu(b.date)) + ', ' + escapeHtml(b.start) + '–' + escapeHtml(b.end) + '</span>'
      + '<span class="card-master">' + escapeHtml(b.masterName || '') + '</span>'
      + '</div>'
      + '<p class="card-service">' + escapeHtml(b.serviceNames || '') + ' · ' + money(b.totalPrice) + '</p>'
      + '<p class="card-client">' + escapeHtml(b.clientName) + ' · ' + escapeHtml(b.clientPhone) + '</p>'
      + (contacts ? '<p class="card-note">Связь: ' + escapeHtml(contacts) + '</p>' : '')
      + (b.comment ? '<p class="card-note">Комментарий: ' + escapeHtml(b.comment) + '</p>' : '')
      + (b.clientNotes ? '<p class="card-note">Заметка о клиенте: ' + escapeHtml(b.clientNotes) + '</p>' : '')
      + '<div class="card-tags">'
      + (isNewBooking(b) ? '<span class="tag tag-new">новая</span>' : '')
      + (b.rescheduledAt ? '<span class="tag">перенесена клиентом</span>' : '')
      + '</div>'
      + '<div class="card-actions">'
      + '<button type="button" class="a-btn a-btn-ghost a-btn-small" data-act="completed">Выполнено</button>'
      + '<button type="button" class="a-btn a-btn-ghost a-btn-small" data-act="no_show">Не пришёл</button>'
      + '<button type="button" class="a-btn a-btn-ghost a-btn-small" data-act="move">Перенести</button>'
      + '<button type="button" class="a-btn a-btn-danger a-btn-small" data-act="delete">Удалить</button>'
      + '</div>'
      + '<div class="card-move" hidden>'
      + '<input type="date" value="' + escapeHtml(b.date) + '">'
      + '<input type="time" step="900" value="' + escapeHtml(b.start) + '">'
      + '<button type="button" class="a-btn a-btn-primary a-btn-small" data-act="save-move">Сохранить</button>'
      + '</div>';

    card.querySelector('[data-act="completed"]').addEventListener('click', function () { markBooking(b, 'completed'); });
    card.querySelector('[data-act="no_show"]').addEventListener('click', function () { markBooking(b, 'no_show'); });
    card.querySelector('[data-act="delete"]').addEventListener('click', function () { deleteBooking(b); });

    var movePanel = card.querySelector('.card-move');
    card.querySelector('[data-act="move"]').addEventListener('click', function () {
      movePanel.hidden = !movePanel.hidden;
    });
    card.querySelector('[data-act="save-move"]').addEventListener('click', function () {
      var inputs = movePanel.querySelectorAll('input');
      moveBooking(b, inputs[0].value, inputs[1].value);
    });

    list.appendChild(card);
  });
}

function markSeen() {
  if (!cache.bookings.length) return;
  callAdmin('markBookingsSeen', {}).then(function (r) {
    if (!handleAuth(r)) return;
    cache.lastSeenAt = new Date().toISOString();
    renderBookings();
  }).catch(function () {});
}

function markBooking(booking, status) {
  var label = status === 'completed' ? 'выполненной' : 'несостоявшейся';
  if (!confirm('Отметить запись ' + booking.clientName + ' как ' + label + '?')) return;

  callAdmin('markBooking', { bookingId: booking.id, status: status }).then(function (r) {
    if (!handleAuth(r)) return;
    loadBookings();
    loadHistory();
    loadClients();
  }).catch(function () { alert('Не удалось сохранить. Попробуйте ещё раз.'); });
}

function deleteBooking(booking) {
  if (!confirm('Удалить запись ' + booking.clientName + ' без сохранения в истории?')) return;

  callAdmin('deleteBooking', { bookingId: booking.id }).then(function (r) {
    if (!handleAuth(r)) return;
    loadBookings();
  }).catch(function () { alert('Не удалось удалить. Попробуйте ещё раз.'); });
}

function moveBooking(booking, date, start) {
  if (!date || !start) return;

  callAdmin('updateBookingTime', { bookingId: booking.id, date: date, start: start }).then(function (r) {
    if (!handleAuth(r)) return;
    if (r.status === 409) { alert('В это время у мастера уже есть запись.'); return; }
    if (r.status !== 200) { alert('Не удалось перенести запись.'); return; }
    loadBookings();
  }).catch(function () { alert('Не удалось перенести запись.'); });
}

// ============================================================
// Расписание
// ============================================================

function renderMasterSelect() {
  var select = document.getElementById('schedule-master-select');
  if (!select || !CONFIG) return;

  select.innerHTML = CONFIG.masters.map(function (m) {
    return '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name) + '</option>';
  }).join('');

  select.addEventListener('change', renderSchedule);
}

function currentMasterId() {
  var select = document.getElementById('schedule-master-select');
  return select ? select.value : null;
}

function renderSchedule() {
  var grid = document.getElementById('schedule-grid');
  if (!grid || !cache.schedule) return;

  var masterId = currentMasterId();
  var days = cache.schedule[masterId] || {};

  if (!cache.scheduleDates.length) {
    grid.innerHTML = '<p class="a-hint">Нет дат для редактирования.</p>';
    return;
  }

  grid.innerHTML = '';

  cache.scheduleDates.forEach(function (date) {
    var day = days[date] || { intervals: [], source: 'template' };
    var isOverride = day.source === 'override';
    var isClosed = !day.intervals.length;

    var row = document.createElement('div');
    row.className = 'schedule-day'
      + (isOverride ? ' is-override' : '')
      + (isClosed ? ' is-closed' : '');

    row.innerHTML =
      '<div class="schedule-day-date">' + escapeHtml(formatDateRu(date))
      + '<span class="schedule-day-source">' + (isOverride ? 'исключение' : 'базовый график') + '</span></div>'
      + '<div class="schedule-intervals"></div>'
      + '<div class="schedule-actions">'
      + '<button type="button" class="a-btn a-btn-ghost a-btn-small" data-act="add">+ интервал</button>'
      + '<button type="button" class="a-btn a-btn-primary a-btn-small" data-act="save">Сохранить</button>'
      + '<button type="button" class="a-btn a-btn-ghost a-btn-small" data-act="close">Закрыть день</button>'
      + (isOverride ? '<button type="button" class="a-btn a-btn-ghost a-btn-small" data-act="reset">К базовому</button>' : '')
      + '</div>';

    var intervalsWrap = row.querySelector('.schedule-intervals');

    function addIntervalRow(start, end) {
      var wrap = document.createElement('div');
      wrap.className = 'schedule-interval';
      wrap.innerHTML =
        '<input type="time" step="900" class="iv-start" value="' + escapeHtml(start || '10:00') + '">'
        + '<span>–</span>'
        + '<input type="time" step="900" class="iv-end" value="' + escapeHtml(end || '19:00') + '">'
        + '<button type="button" class="a-btn a-btn-ghost a-btn-small" data-act="remove">×</button>';
      wrap.querySelector('[data-act="remove"]').addEventListener('click', function () { wrap.remove(); });
      intervalsWrap.appendChild(wrap);
    }

    if (isClosed) {
      var closed = document.createElement('span');
      closed.className = 'a-hint';
      closed.textContent = 'выходной';
      intervalsWrap.appendChild(closed);
    } else {
      day.intervals.forEach(function (iv) { addIntervalRow(iv.start, iv.end); });
    }

    row.querySelector('[data-act="add"]').addEventListener('click', function () {
      var hint = intervalsWrap.querySelector('.a-hint');
      if (hint) hint.remove();
      addIntervalRow('10:00', '19:00');
    });

    row.querySelector('[data-act="save"]').addEventListener('click', function () {
      var intervals = Array.prototype.slice.call(intervalsWrap.querySelectorAll('.schedule-interval')).map(function (el) {
        return { start: el.querySelector('.iv-start').value, end: el.querySelector('.iv-end').value };
      });
      saveScheduleDay(masterId, date, intervals);
    });

    row.querySelector('[data-act="close"]').addEventListener('click', function () {
      if (!confirm('Сделать ' + formatDateRu(date) + ' выходным?')) return;
      saveScheduleDay(masterId, date, []);
    });

    var resetBtn = row.querySelector('[data-act="reset"]');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () { resetScheduleDay(masterId, date); });
    }

    grid.appendChild(row);
  });
}

function saveScheduleDay(masterId, date, intervals) {
  callAdmin('saveScheduleDay', { masterId: masterId, date: date, intervals: intervals }).then(function (r) {
    if (!handleAuth(r)) return;
    if (r.status === 400 && r.json && r.json.error === 'overlapping-intervals') {
      alert('Интервалы пересекаются — исправьте время.');
      return;
    }
    if (r.status !== 200) { alert('Не удалось сохранить день.'); return; }
    loadSchedule();
  }).catch(function () { alert('Не удалось сохранить день.'); });
}

function resetScheduleDay(masterId, date) {
  callAdmin('resetScheduleDay', { masterId: masterId, date: date }).then(function (r) {
    if (!handleAuth(r)) return;
    loadSchedule();
  }).catch(function () { alert('Не удалось вернуть базовый график.'); });
}

// ============================================================
// История
// ============================================================

var STATUS_LABELS = { completed: 'Выполнено', no_show: 'Не пришёл' };

function renderHistory() {
  var list = document.getElementById('history-list');
  var sorted = cache.history.slice().sort(function (a, b) {
    return (a.closedAt || '') < (b.closedAt || '') ? 1 : -1;
  });

  if (!sorted.length) {
    list.innerHTML = '<p class="a-hint">История пуста.</p>';
    return;
  }

  list.innerHTML = sorted.map(function (h) {
    var statusClass = h.status === 'completed' ? 'tag-done' : 'tag-noshow';
    return '<div class="admin-card">'
      + '<div class="card-head">'
      + '<span class="card-when">' + escapeHtml(formatDateRu(h.date)) + ', ' + escapeHtml(h.start) + '–' + escapeHtml(h.end) + '</span>'
      + '<span class="card-master">' + escapeHtml(h.masterName || '') + '</span>'
      + '</div>'
      + '<p class="card-service">' + escapeHtml(h.serviceNames || '') + ' · ' + money(h.totalPrice) + '</p>'
      + '<p class="card-client">' + escapeHtml(h.clientName) + ' · ' + escapeHtml(h.clientPhone) + '</p>'
      + '<div class="card-tags"><span class="tag ' + statusClass + '">' + escapeHtml(STATUS_LABELS[h.status] || h.status) + '</span></div>'
      + '</div>';
  }).join('');
}

// ============================================================
// Клиенты
// ============================================================

function renderClients() {
  var list = document.getElementById('clients-list');
  var phones = Object.keys(cache.clients);

  if (!phones.length) {
    list.innerHTML = '<p class="a-hint">Клиентская база наполняется, когда записи отмечаются выполненными.</p>';
    return;
  }

  // Сортируем по числу визитов: постоянные клиенты сверху.
  phones.sort(function (a, b) { return (cache.clients[b].visits || 0) - (cache.clients[a].visits || 0); });

  list.innerHTML = '';
  phones.forEach(function (phone) {
    var c = cache.clients[phone];
    var card = document.createElement('div');
    card.className = 'admin-card';
    card.innerHTML =
      '<div class="card-head">'
      + '<span class="card-when">' + escapeHtml(c.name) + '</span>'
      + '<span class="card-master">' + escapeHtml(c.phone) + '</span>'
      + '</div>'
      + '<p class="card-note">' + (c.visits || 0) + ' ' + plural(c.visits || 0, ['визит', 'визита', 'визитов'])
      + ' · на сумму ' + money(c.totalSpent)
      + (c.lastVisit ? ' · последний ' + escapeHtml(formatDateRu(c.lastVisit)) : '') + '</p>'
      + '<div class="client-notes">'
      + '<textarea rows="2" placeholder="Заметка о клиенте">' + escapeHtml(c.notes || '') + '</textarea>'
      + '<button type="button" class="a-btn a-btn-ghost a-btn-small" style="margin-top:8px">Сохранить заметку</button>'
      + '</div>';

    var textarea = card.querySelector('textarea');
    if (CONFIG) textarea.maxLength = CONFIG.limits.clientNoteMax;

    card.querySelector('button').addEventListener('click', function () {
      callAdmin('saveClientNote', { phone: phone, notes: textarea.value }).then(function (r) {
        if (!handleAuth(r)) return;
        if (r.status !== 200) { alert('Не удалось сохранить заметку.'); return; }
        loadClients();
      }).catch(function () { alert('Не удалось сохранить заметку.'); });
    });

    list.appendChild(card);
  });
}

// ============================================================
// Аналитика — считается на клиенте из уже загруженной истории
// ============================================================

function renderAnalytics() {
  var cards = document.getElementById('analytics-cards');
  var tables = document.getElementById('analytics-tables');

  var completed = cache.history.filter(function (h) { return h.status === 'completed'; });
  var noShow = cache.history.filter(function (h) { return h.status === 'no_show'; });
  var revenue = completed.reduce(function (sum, h) { return sum + (h.totalPrice || 0); }, 0);
  var average = completed.length ? Math.round(revenue / completed.length) : 0;

  cards.innerHTML =
    analyticsCard(completed.length, plural(completed.length, ['визит выполнен', 'визита выполнено', 'визитов выполнено']))
    + analyticsCard(money(revenue), 'выручка')
    + analyticsCard(money(average), 'средний чек')
    + analyticsCard(noShow.length, 'не пришли')
    + analyticsCard(cache.bookings.length, plural(cache.bookings.length, ['запись впереди', 'записи впереди', 'записей впереди']));

  // По мастерам
  var byMaster = {};
  completed.forEach(function (h) {
    var key = h.masterName || '—';
    if (!byMaster[key]) byMaster[key] = { visits: 0, revenue: 0 };
    byMaster[key].visits += 1;
    byMaster[key].revenue += h.totalPrice || 0;
  });

  // По услугам: в брони их может быть несколько, считаем каждую отдельно.
  var byService = {};
  completed.forEach(function (h) {
    (h.services || []).forEach(function (s) {
      if (!byService[s.name]) byService[s.name] = { count: 0, revenue: 0 };
      byService[s.name].count += 1;
      byService[s.name].revenue += s.price || 0;
    });
  });

  tables.innerHTML =
    analyticsTable('Мастера', Object.keys(byMaster).map(function (name) {
      var visits = byMaster[name].visits;
      return {
        label: name,
        value: visits + ' ' + plural(visits, ['визит', 'визита', 'визитов']) + ' · ' + money(byMaster[name].revenue),
      };
    }))
    + analyticsTable('Услуги', Object.keys(byService)
      .sort(function (a, b) { return byService[b].count - byService[a].count; })
      .map(function (name) {
        return { label: name, value: byService[name].count + ' × · ' + money(byService[name].revenue) };
      }));
}

function analyticsCard(value, label) {
  return '<div class="analytics-card">'
    + '<p class="analytics-value">' + escapeHtml(String(value)) + '</p>'
    + '<p class="analytics-label">' + escapeHtml(label) + '</p></div>';
}

function analyticsTable(title, rows) {
  if (!rows.length) {
    return '<div class="analytics-table"><h3>' + escapeHtml(title) + '</h3><p class="a-hint">Пока нет данных.</p></div>';
  }
  return '<div class="analytics-table"><h3>' + escapeHtml(title) + '</h3>'
    + rows.map(function (r) {
      return '<div class="analytics-row"><span>' + escapeHtml(r.label) + '</span><span>' + escapeHtml(r.value) + '</span></div>';
    }).join('')
    + '</div>';
}
