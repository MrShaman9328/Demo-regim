// ============================================================
// Клиентская часть онлайн-записи.
//
// В этом файле нет ни одной услуги, цены, имени мастера или контакта:
// всё приходит с бэкенда действием getConfig и рендерится здесь.
// Чтобы развернуть салон, правится config.json в бакете, а не код.
//
// TODO: подставить адрес своей Cloud Function после её создания.
// ============================================================
var CLOUD_FUNCTION_URL = 'https://functions.yandexcloud.net/ЗАМЕНИТЕ_НА_ID_ФУНКЦИИ';

// Зависшее соединение (мобильный интернет, оператор режет трафик) не должно
// превращаться в бесконечно «думающую» страницу — рвём запрос сами.
var BACKEND_TIMEOUT_MS = 20000;

function callBackend(action, data) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function () { controller.abort(); }, BACKEND_TIMEOUT_MS);

  return fetch(CLOUD_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action }, data || {})),
    signal: controller.signal,
  })
    .then(function (res) { return res.json(); })
    .finally(function () { clearTimeout(timeoutId); });
}

// Экранируем всё, что попадает в innerHTML: часть данных приходит с сервера
// по чужому запросу (например, имена услуг в «Моих записях»), так что это
// не только self-XSS.
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ---------- Состояние ----------

var CONFIG = null;
var AVAILABILITY = null;       // { dates: [...], availability: { masterId: { date: {intervals, booked} } } }

var selectedServices = [];     // объекты услуг из конфига
var selectedMasterId = null;
var pickedDate = null;
var pickedStart = null;
var pendingBookingId = null;

// ---------- Время ----------

function pad2(n) { return String(n).padStart(2, '0'); }

function timeToMin(t) {
  var parts = String(t).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function minToTime(m) {
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

function formatDateRu(iso) {
  var d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
}

// Часовой пояс салона берём из конфига явным смещением, а не с часов
// устройства: переведённые назад часы иначе показали бы прошедшие слоты
// как доступные.
function slotTimestamp(dateIso, timeStr) {
  return new Date(dateIso + 'T' + timeStr + ':00' + CONFIG.booking.timezoneOffset).getTime();
}

function earliestBookableTimestamp() {
  return Date.now() + CONFIG.booking.minLeadMinutes * 60 * 1000;
}

function totalDuration() {
  return selectedServices.reduce(function (sum, s) { return sum + s.duration; }, 0);
}

function totalPrice() {
  return selectedServices.reduce(function (sum, s) { return sum + s.price; }, 0);
}

// ---------- Телефон ----------

function formatPhoneDigits(digits) {
  if (digits.charAt(0) === '8') digits = '7' + digits.slice(1);
  if (digits.charAt(0) !== '7') digits = '7' + digits;
  digits = digits.slice(0, 11);

  var rest = digits.slice(1);
  var out = '+7';
  if (rest.length > 0) out += ' (' + rest.slice(0, 3);
  if (rest.length >= 3) out += ')';
  if (rest.length > 3) out += ' ' + rest.slice(3, 6);
  if (rest.length > 6) out += '-' + rest.slice(6, 8);
  if (rest.length > 8) out += '-' + rest.slice(8, 10);
  return out;
}

function attachPhoneMask(input) {
  if (!input) return;

  // Backspace обрабатываем сами: иначе браузер стирает последний символ
  // строки — часто это «)» или «-», форматтер тут же дорисовывает его
  // обратно, и ввод залипает на границе скобок.
  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Backspace') return;
    e.preventDefault();
    var digits = input.value.replace(/\D/g, '').slice(0, -1);
    input.value = digits ? formatPhoneDigits(digits) : '';
  });

  input.addEventListener('input', function () {
    var digits = input.value.replace(/\D/g, '');
    input.value = digits ? formatPhoneDigits(digits) : '';
  });

  input.addEventListener('focus', function () {
    if (!input.value) input.value = '+7 ';
  });
}

// ============================================================
// Загрузка конфигурации и первичный рендер
// ============================================================

document.addEventListener('DOMContentLoaded', function () {
  callBackend('getConfig')
    .then(function (res) {
      if (!res || !res.config) throw new Error('пустой конфиг');
      CONFIG = res.config;
      applyConfig();
    })
    .catch(function (err) {
      console.error('Не удалось загрузить конфигурацию салона:', err);
      var list = document.getElementById('services-list');
      if (list) {
        list.innerHTML = '<p class="loading-note">Не удалось загрузить данные салона. Обновите страницу или попробуйте позже.</p>';
      }
    });
});

function applyConfig() {
  applyBrand();
  applyTexts();
  renderServices();
  renderContactMethods();
  renderFooter();
  renderDemoBlocks();
  applyFieldLimits();

  document.querySelectorAll('input[type="tel"]').forEach(attachPhoneMask);
}

// Брендинг — это значения CSS-переменных из конфига. Правки стилей под
// нового клиента не требуются, пока хватает палитры.
function applyBrand() {
  var colors = (CONFIG.brand && CONFIG.brand.colors) || {};
  Object.keys(colors).forEach(function (name) {
    document.documentElement.style.setProperty(name, colors[name]);
  });
}

function applyTexts() {
  var salon = CONFIG.salon || {};

  document.title = salon.title || salon.name || 'Онлайн-запись';
  setText('brand-name', salon.name);
  setText('hero-title', salon.name);
  setText('hero-tagline', salon.tagline);

  var about = salon.about || {};
  setText('about-title', about.title || 'О салоне');
  setText('about-text', about.text);

  var facts = document.getElementById('about-facts');
  if (facts) {
    facts.innerHTML = (salon.facts || [])
      .map(function (f) { return '<li>' + escapeHtml(f) + '</li>'; })
      .join('');
  }
}

function setText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value || '';
}

// Длина полей задаётся конфигом — это же ограничение проверяет сервер.
// В демо-режиме лимиты ужаты, чтобы форму нельзя было завалить простынёй.
function applyFieldLimits() {
  var name = document.getElementById('client-name-input');
  if (name) name.maxLength = CONFIG.limits.clientNameMax;

  var comment = document.getElementById('client-comment-input');
  if (comment) comment.maxLength = CONFIG.limits.commentMax;
}

// ---------- Услуги ----------

function renderServices() {
  var wrap = document.getElementById('services-list');
  if (!wrap) return;

  if (!CONFIG.services.length) {
    wrap.innerHTML = '<p class="loading-note">Услуги пока не настроены.</p>';
    return;
  }

  wrap.innerHTML = CONFIG.services.map(function (s) {
    return '<article class="service-card" data-service-id="' + escapeHtml(s.id) + '">'
      + '<p class="service-name">' + escapeHtml(s.name) + '</p>'
      + (s.description ? '<p class="service-note">' + escapeHtml(s.description) + '</p>' : '')
      + '<div class="service-footer">'
      + '<span class="service-meta">' + s.duration + ' мин · ' + Number(s.price).toLocaleString('ru-RU') + ' ₽</span>'
      + '<button type="button" class="service-pick" data-service-id="' + escapeHtml(s.id) + '">Выбрать</button>'
      + '</div></article>';
  }).join('');

  wrap.querySelectorAll('.service-pick').forEach(function (btn) {
    btn.addEventListener('click', function () { toggleService(btn.getAttribute('data-service-id')); });
  });

  var hint = document.getElementById('services-hint');
  if (hint && CONFIG.booking.maxServicesPerBooking > 1) {
    hint.textContent = 'Выберите услугу — можно совместить до '
      + CONFIG.booking.maxServicesPerBooking + ' за один визит.';
  }
}

function toggleService(id) {
  var idx = selectedServices.findIndex(function (s) { return s.id === id; });

  if (idx !== -1) {
    selectedServices.splice(idx, 1);
  } else {
    if (selectedServices.length >= CONFIG.booking.maxServicesPerBooking) {
      alert('За один визит можно выбрать не больше ' + CONFIG.booking.maxServicesPerBooking + ' услуг.');
      return;
    }
    var service = CONFIG.services.find(function (s) { return s.id === id; });
    if (!service) return;
    selectedServices.push(service);
  }

  // Смена набора услуг меняет и длительность, и список подходящих мастеров —
  // ранее выбранный мастер может больше не подходить.
  selectedMasterId = null;
  pickedDate = null;
  pickedStart = null;

  updateServiceCards();
  updateBookingBar();
}

function updateServiceCards() {
  document.querySelectorAll('.service-card').forEach(function (card) {
    var id = card.getAttribute('data-service-id');
    var picked = selectedServices.some(function (s) { return s.id === id; });
    card.classList.toggle('picked', picked);
    var btn = card.querySelector('.service-pick');
    if (btn) btn.textContent = picked ? 'Выбрано ✓' : 'Выбрать';
  });
}

function updateBookingBar() {
  var bar = document.getElementById('booking-bar');
  var summary = document.getElementById('booking-bar-summary');
  if (!bar || !summary) return;

  if (!selectedServices.length) {
    bar.hidden = true;
    return;
  }

  summary.textContent = 'Выбрано: ' + selectedServices.length
    + ' · ' + totalDuration() + ' мин · ' + totalPrice().toLocaleString('ru-RU') + ' ₽';
  bar.hidden = false;
}

// ---------- Способы связи ----------

function renderContactMethods() {
  var wrap = document.getElementById('contact-methods');
  if (!wrap) return;

  wrap.innerHTML = CONFIG.contactMethods.map(function (m) {
    return '<label class="choice-chip">'
      + '<input type="checkbox" name="contactMethod" value="' + escapeHtml(m.id) + '">'
      + '<span>' + escapeHtml(m.label) + '</span></label>';
  }).join('');
}

// ---------- Подвал ----------

function renderFooter() {
  var salon = CONFIG.salon || {};

  setText('footer-name', salon.name);
  setText('footer-address', salon.address);

  var phone = document.getElementById('footer-phone');
  if (phone) {
    if (salon.phone) {
      phone.textContent = salon.phone;
      phone.href = salon.phoneHref || ('tel:' + String(salon.phone).replace(/\D/g, ''));
      phone.hidden = false;
    } else {
      phone.hidden = true;
    }
  }

  var socials = document.getElementById('footer-socials');
  if (socials) {
    socials.innerHTML = (salon.socials || []).map(function (s) {
      return '<a class="footer-social" href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener">'
        + escapeHtml(s.label) + '</a>';
    }).join('');
  }
}

// ---------- Демо-блоки ----------

// Тексты демо-режима приходят с сервера и только при DEMO_MODE=true —
// в боевом развёртывании этих блоков нет ни на странице, ни в ответе.
function renderDemoBlocks() {
  if (!CONFIG.demoMode || !CONFIG.demo) return;
  var demo = CONFIG.demo;

  var notice = document.getElementById('demo-notice');
  if (notice && demo.noticeText) {
    notice.textContent = demo.noticeText;
    notice.hidden = false;
    document.body.classList.add('has-demo-notice');
  }

  var cta = document.getElementById('demo-cta');
  if (!cta) return;

  var html = '<div class="container">';

  html += '<div class="demo-card">'
    + '<p class="demo-card-title">' + escapeHtml(demo.ctaTitle || '') + '</p>'
    + (demo.ctaText ? '<p class="demo-card-text">' + escapeHtml(demo.ctaText) + '</p>' : '')
    + (demo.ctaUrl
      ? '<a class="btn btn-primary" href="' + escapeHtml(demo.ctaUrl) + '" target="_blank" rel="noopener">'
        + escapeHtml(demo.ctaLabel || 'Подробнее') + '</a>'
      : '')
    + '</div>';

  if (demo.adminUrl) {
    html += '<div class="demo-card demo-card-admin">'
      + '<p class="demo-card-title">' + escapeHtml(demo.adminTitle || 'Админ-панель открыта') + '</p>'
      + '<p class="demo-card-text">Админ-панель: '
      + '<a href="' + escapeHtml(demo.adminUrl) + '">' + escapeHtml(demo.adminUrlLabel || demo.adminUrl) + '</a>'
      + ' — логин <code>' + escapeHtml(demo.adminLogin || '') + '</code>'
      + ', пароль <code>' + escapeHtml(demo.adminPassword || '') + '</code></p>'
      + '</div>';
  }

  html += '</div>';
  cta.innerHTML = html;
  cta.hidden = false;
}

// ============================================================
// Шаги записи
// ============================================================

var bookingSection = document.getElementById('zapis');

document.getElementById('booking-bar-next').addEventListener('click', function () {
  if (!selectedServices.length) return;
  bookingSection.hidden = false;
  lockCatalog(true);
  renderMasters();
  goToStep(1);
  bookingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Пока клиент на шагах записи, каталог зафиксирован: случайный клик по
// услуге иначе разъехался бы с уже выбранными мастером и временем.
function lockCatalog(locked) {
  var section = document.getElementById('uslugi');
  if (section) section.classList.toggle('services-locked', locked);
}

function goToStep(n) {
  document.querySelectorAll('.booking-step').forEach(function (el) {
    el.hidden = (parseInt(el.getAttribute('data-step'), 10) !== n);
  });
  document.querySelectorAll('.progress-step').forEach(function (el, i) {
    el.classList.toggle('active', i + 1 <= n);
  });
}

document.querySelectorAll('[data-back]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var target = parseInt(btn.getAttribute('data-back'), 10);
    if (target === 0) {
      lockCatalog(false);
      bookingSection.hidden = true;
      document.getElementById('uslugi').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    goToStep(target);
  });
});

// ---------- Шаг 1: мастер ----------

function mastersForSelection() {
  return CONFIG.masters.filter(function (m) {
    return selectedServices.every(function (s) { return m.serviceIds.indexOf(s.id) !== -1; });
  });
}

var WEEKDAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
var WEEKDAY_LABELS = { mon: 'пн', tue: 'вт', wed: 'ср', thu: 'чт', fri: 'пт', sat: 'сб', sun: 'вс' };

// Недельный график в человеческом виде: подряд идущие одинаковые дни
// сворачиваются в диапазон («пн–пт 10:00–19:00»).
function formatWeeklySchedule(master) {
  var groups = [];

  WEEKDAY_ORDER.forEach(function (day) {
    var intervals = (master.weeklySchedule && master.weeklySchedule[day]) || [];
    if (!intervals.length) return;

    var hours = intervals.map(function (iv) { return iv.start + '–' + iv.end; }).join(', ');
    var last = groups[groups.length - 1];
    var isNext = last && WEEKDAY_ORDER.indexOf(day) === WEEKDAY_ORDER.indexOf(last.to) + 1;

    if (last && last.hours === hours && isNext) last.to = day;
    else groups.push({ from: day, to: day, hours: hours });
  });

  if (!groups.length) return 'график уточняется';

  return groups.map(function (g) {
    var days = g.from === g.to
      ? WEEKDAY_LABELS[g.from]
      : WEEKDAY_LABELS[g.from] + '–' + WEEKDAY_LABELS[g.to];
    return days + ' ' + g.hours;
  }).join(', ');
}

function renderMasters() {
  var wrap = document.getElementById('master-picker');
  if (!wrap) return;

  var masters = mastersForSelection();

  if (!masters.length) {
    wrap.innerHTML = '<p class="booking-step-placeholder">Нет мастера, который оказывает все выбранные услуги сразу. Вернитесь к услугам и измените выбор.</p>';
    return;
  }

  wrap.innerHTML = masters.map(function (m) {
    return '<article class="master-card" data-master-id="' + escapeHtml(m.id) + '">'
      + '<p class="master-name">' + escapeHtml(m.name) + '</p>'
      + (m.title ? '<p class="master-title">' + escapeHtml(m.title) + '</p>' : '')
      + (m.about ? '<p class="master-about">' + escapeHtml(m.about) + '</p>' : '')
      + '<p class="master-schedule">' + escapeHtml(formatWeeklySchedule(m)) + '</p>'
      + '<button type="button" class="btn btn-ghost master-pick">Выбрать</button>'
      + '</article>';
  }).join('');

  wrap.querySelectorAll('.master-card').forEach(function (card) {
    card.querySelector('.master-pick').addEventListener('click', function () {
      selectedMasterId = card.getAttribute('data-master-id');
      pickedDate = null;
      pickedStart = null;
      wrap.querySelectorAll('.master-card').forEach(function (c) { c.classList.remove('picked'); });
      card.classList.add('picked');
      document.getElementById('to-step-3').disabled = true;
      goToStep(2);
      buildDatePicker();
    });
  });
}

// ---------- Доступность ----------

function fetchAvailability(force) {
  if (AVAILABILITY && !force) return Promise.resolve(AVAILABILITY);

  return callBackend('getAvailability', {})
    .then(function (res) {
      AVAILABILITY = { dates: (res && res.dates) || [], availability: (res && res.availability) || {} };
      return AVAILABILITY;
    })
    .catch(function (err) {
      console.warn('Не удалось получить доступность:', err);
      AVAILABILITY = { dates: [], availability: {} };
      return AVAILABILITY;
    });
}

function dayData(masterId, dateIso) {
  var forMaster = AVAILABILITY.availability[masterId];
  return (forMaster && forMaster[dateIso]) || { intervals: [], booked: [] };
}

// Перебор сетки внутри рабочих интервалов. Правила ровно те же, что
// на сервере (шаг, буфер, лид-тайм) — сервер проверяет их повторно,
// здесь они нужны, чтобы нарисовать сетку.
//
// Возвращаем ВСЕ слоты дня с признаком доступности, а не только
// свободные: занятое время видно как перечёркнутое, и клиенту сразу
// понятно, что мастер реально загружен, а не «сайт ничего не нашёл».
function gridSlotsFor(masterId, dateIso, duration, ignoreSlot) {
  var day = dayData(masterId, dateIso);
  var step = CONFIG.booking.slotStepMinutes;
  var buffer = CONFIG.booking.bufferMinutes;
  var cutoff = earliestBookableTimestamp();

  var booked = day.booked.filter(function (b) {
    if (!ignoreSlot) return true;
    return !(b.start === ignoreSlot.start && b.end === ignoreSlot.end);
  });

  var slots = [];

  day.intervals.forEach(function (iv) {
    var from = timeToMin(iv.start);
    var to = timeToMin(iv.end);

    for (var start = from; start + duration <= to; start += step) {
      var time = minToTime(start);
      var tooSoon = slotTimestamp(dateIso, time) < cutoff;

      var candStart = start - buffer;
      var candEnd = start + duration + buffer;
      var conflict = booked.some(function (b) {
        return candStart < timeToMin(b.end) && candEnd > timeToMin(b.start);
      });

      slots.push({ time: time, free: !tooSoon && !conflict, tooSoon: tooSoon });
    }
  });

  return slots;
}

// Слоты, на которые реально можно записаться, — прошедшие в счёт не идут.
function freeStartsFor(masterId, dateIso, duration, ignoreSlot) {
  return gridSlotsFor(masterId, dateIso, duration, ignoreSlot)
    .filter(function (s) { return s.free; })
    .map(function (s) { return s.time; });
}

// ---------- Шаг 2: дата и время ----------

function buildDatePicker() {
  var wrap = document.getElementById('date-picker');
  if (!wrap) return;
  wrap.innerHTML = '<p class="booking-step-placeholder">Загружаем расписание…</p>';

  var duration = totalDuration();

  fetchAvailability(true).then(function (data) {
    wrap.innerHTML = '';

    if (!data.dates.length) {
      wrap.innerHTML = '<p class="booking-step-placeholder">Расписание пока недоступно. Попробуйте позже.</p>';
      return;
    }

    data.dates.forEach(function (iso) {
      var d = new Date(iso + 'T00:00:00');
      var free = freeStartsFor(selectedMasterId, iso, duration, null);

      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'date-chip';
      chip.dataset.date = iso;
      chip.disabled = free.length === 0;
      chip.innerHTML = '<span>' + d.toLocaleDateString('ru-RU', { weekday: 'short' }) + '</span>'
        + '<span class="date-chip-day">' + d.getDate() + '</span>';

      if (free.length) {
        chip.addEventListener('click', function () {
          wrap.querySelectorAll('.date-chip').forEach(function (c) { c.classList.remove('picked'); });
          chip.classList.add('picked');
          pickedDate = iso;
          pickedStart = null;
          document.getElementById('to-step-3').disabled = true;
          buildTimeSlots();
        });
      }

      wrap.appendChild(chip);
    });
  });
}

function buildTimeSlots() {
  var wrap = document.getElementById('time-picker');
  if (!wrap || !pickedDate) return;

  var slots = gridSlotsFor(selectedMasterId, pickedDate, totalDuration(), null);

  if (!slots.length) {
    wrap.innerHTML = '<p class="booking-step-placeholder">В этот день мастер не работает — выберите другую дату.</p>';
    return;
  }
  if (!slots.some(function (s) { return s.free; })) {
    wrap.innerHTML = '<p class="booking-step-placeholder">На эту дату свободного времени не осталось — выберите другой день.</p>';
    return;
  }

  wrap.innerHTML = '';
  slots.forEach(function (slot) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'time-slot';
    btn.textContent = slot.time;
    btn.disabled = !slot.free;
    if (!slot.free && !slot.tooSoon) btn.title = 'Время занято';

    if (slot.free) {
      btn.addEventListener('click', function () {
        wrap.querySelectorAll('.time-slot').forEach(function (s) { s.classList.remove('picked'); });
        btn.classList.add('picked');
        pickedStart = slot.time;
        document.getElementById('to-step-3').disabled = false;
      });
    }

    wrap.appendChild(btn);
  });
}

document.getElementById('to-step-3').addEventListener('click', function () {
  if (!pickedDate || !pickedStart) return;
  goToStep(3);
});

// ---------- Шаг 3: контакты ----------

function selectedContactMethods() {
  var form = document.getElementById('booking-contact-form');
  return Array.prototype.slice
    .call(form.querySelectorAll('input[name="contactMethod"]:checked'))
    .map(function (el) { return el.value; });
}

document.getElementById('to-step-4').addEventListener('click', function () {
  var form = document.getElementById('booking-contact-form');
  var errorEl = document.getElementById('step3-error');

  var name = form.name.value.trim();
  var phone = form.phone.value.trim();
  var consent = form.consent.checked;
  var methods = selectedContactMethods();

  if (name.length < 2 || phone.replace(/\D/g, '').length !== 11 || !consent || !methods.length) {
    errorEl.hidden = false;
    return;
  }
  errorEl.hidden = true;

  buildFinalSummary();
  goToStep(4);
});

// ---------- Шаг 4: подтверждение ----------

// id брони генерируется один раз при показе итоговой карточки, а не при
// каждом нажатии «Подтвердить». Повторное нажатие после сетевой ошибки
// отправит тот же id — сервер узнает его и вернёт уже созданную бронь,
// вместо того чтобы отвечать «время занято» на собственную же запись.
function generateBookingId() {
  return 'b-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function masterById(id) {
  return CONFIG.masters.find(function (m) { return m.id === id; }) || { name: '' };
}

function buildFinalSummary() {
  var el = document.getElementById('booking-final-summary');
  if (!el) return;

  pendingBookingId = generateBookingId();

  var form = document.getElementById('booking-contact-form');
  var labels = selectedContactMethods().map(function (id) {
    var found = CONFIG.contactMethods.find(function (c) { return c.id === id; });
    return found ? found.label : id;
  });
  var endTime = minToTime(timeToMin(pickedStart) + totalDuration());

  el.innerHTML =
    '<p><strong>Услуги:</strong> ' + escapeHtml(selectedServices.map(function (s) { return s.name + ' (' + s.duration + ' мин)'; }).join(', ')) + '</p>'
    + '<p><strong>Мастер:</strong> ' + escapeHtml(masterById(selectedMasterId).name) + '</p>'
    + '<p><strong>Дата и время:</strong> ' + escapeHtml(formatDateRu(pickedDate)) + ', ' + escapeHtml(pickedStart) + '–' + escapeHtml(endTime) + '</p>'
    + '<p><strong>Имя:</strong> ' + escapeHtml(form.name.value.trim()) + '</p>'
    + '<p><strong>Телефон:</strong> ' + escapeHtml(form.phone.value.trim()) + '</p>'
    + '<p><strong>Связь:</strong> ' + escapeHtml(labels.join(', ')) + '</p>'
    + '<p class="summary-total">Итого: ' + totalPrice().toLocaleString('ru-RU') + ' ₽</p>';
}

var confirmBtn = document.getElementById('confirm-booking');

confirmBtn.addEventListener('click', function () {
  var form = document.getElementById('booking-contact-form');
  if (!pendingBookingId) pendingBookingId = generateBookingId();

  var booking = {
    id: pendingBookingId,
    masterId: selectedMasterId,
    serviceIds: selectedServices.map(function (s) { return s.id; }),
    date: pickedDate,
    start: pickedStart,
    clientName: form.name.value.trim(),
    clientPhone: form.phone.value.trim(),
    comment: form.comment.value.trim(),
    contactMethods: selectedContactMethods(),
  };

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Записываем…';

  callBackend('createBooking', { booking: booking })
    .then(function (res) {
      if (res && res.ok) {
        showSuccess();
      } else if (res && res.error === 'slot-taken') {
        alert('Это время успели занять, пока вы оформляли запись. Выберите другое.');
        goToStep(2);
        buildDatePicker();
      } else {
        alert('Не получилось записаться. Проверьте данные и попробуйте ещё раз.');
      }
    })
    .catch(function (err) {
      console.warn('Ошибка при отправке брони:', err);
      if (err && err.name === 'AbortError') {
        alert('Сервер долго не отвечает. Нажмите «Подтвердить запись» ещё раз — если бронь уже создалась, дубля не будет.');
      } else {
        alert('Не получилось записаться — проблема с соединением. Нажмите «Подтвердить запись» ещё раз.');
      }
    })
    .finally(function () {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Подтвердить запись';
    });
});

function showSuccess() {
  document.querySelectorAll('.booking-step').forEach(function (el) { el.hidden = true; });
  document.getElementById('booking-progress').hidden = true;
  document.getElementById('booking-bar').hidden = true;

  var endTime = minToTime(timeToMin(pickedStart) + totalDuration());
  document.getElementById('booking-success-details').textContent =
    selectedServices.map(function (s) { return s.name; }).join(', ')
    + ' · ' + masterById(selectedMasterId).name
    + ' · ' + formatDateRu(pickedDate) + ', ' + pickedStart + '–' + endTime;

  document.getElementById('booking-success').hidden = false;
}

document.getElementById('book-again-btn').addEventListener('click', function () {
  selectedServices = [];
  selectedMasterId = null;
  pickedDate = null;
  pickedStart = null;
  pendingBookingId = null;
  AVAILABILITY = null; // слоты уже изменились — перечитаем при следующем заходе

  updateServiceCards();
  updateBookingBar();
  lockCatalog(false);

  var form = document.getElementById('booking-contact-form');
  if (form) form.reset();

  document.getElementById('booking-progress').hidden = false;
  document.getElementById('booking-success').hidden = true;
  document.getElementById('date-picker').innerHTML = '';
  document.getElementById('time-picker').innerHTML = '<p class="booking-step-placeholder">Сначала выберите дату выше.</p>';
  document.getElementById('to-step-3').disabled = true;
  bookingSection.hidden = true;

  document.getElementById('uslugi').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ============================================================
// «Мои записи»: поиск по телефону, отмена, перенос
// ============================================================

var mybookingsModal = document.getElementById('mybookings-modal');

document.getElementById('open-mybookings-modal').addEventListener('click', function () {
  mybookingsModal.showModal();
});
document.getElementById('close-mybookings-modal').addEventListener('click', function () {
  mybookingsModal.close();
});
mybookingsModal.addEventListener('click', function (e) {
  if (e.target === mybookingsModal) mybookingsModal.close();
});

var findBtn = document.getElementById('mybookings-find-btn');

findBtn.addEventListener('click', function () {
  var phone = document.getElementById('mybookings-phone').value.trim();
  var hp = document.getElementById('mybookings-hp').value;
  var errorEl = document.getElementById('mybookings-error');
  var resultsEl = document.getElementById('mybookings-results');

  // Кнопка доступна и до загрузки конфига (модалку можно открыть сразу) —
  // без него нечем считать сетку переноса.
  if (!CONFIG) {
    errorEl.textContent = 'Данные ещё загружаются, попробуйте через пару секунд.';
    errorEl.hidden = false;
    return;
  }

  if (phone.replace(/\D/g, '').length < 10) {
    errorEl.textContent = 'Введите номер телефона полностью.';
    errorEl.hidden = false;
    return;
  }
  errorEl.hidden = true;

  findBtn.disabled = true;
  findBtn.textContent = 'Ищем…';

  Promise.all([callBackend('getBookingsByPhone', { phone: phone, hp: hp }), fetchAvailability(true)])
    .then(function (results) {
      var bookings = (results[0] && results[0].bookings) || [];
      if (!bookings.length) {
        errorEl.textContent = 'Записей на этот номер не нашли — проверьте, верно ли введён номер.';
        errorEl.hidden = false;
        resultsEl.hidden = true;
        return;
      }
      renderMyBookings(bookings, phone);
      resultsEl.hidden = false;
    })
    .catch(function (err) {
      console.warn('Не удалось получить записи:', err);
      errorEl.textContent = 'Сервер не отвечает. Попробуйте позже.';
      errorEl.hidden = false;
    })
    .finally(function () {
      findBtn.disabled = false;
      findBtn.textContent = 'Найти мои записи';
    });
});

function renderMyBookings(bookings, phone) {
  var resultsEl = document.getElementById('mybookings-results');
  resultsEl.innerHTML = '';

  bookings.forEach(function (b) {
    var card = document.createElement('div');
    card.className = 'mybooking-card';
    card.innerHTML =
      '<p class="mybooking-service">' + escapeHtml(b.serviceNames) + '</p>'
      + '<p class="mybooking-meta">' + escapeHtml(b.masterName) + ' · '
      + escapeHtml(formatDateRu(b.date)) + ', ' + escapeHtml(b.start) + '–' + escapeHtml(b.end) + '</p>'
      + '<div class="mybooking-actions">'
      + '<button type="button" class="btn btn-ghost btn-small btn-reschedule">Перенести</button>'
      + '<button type="button" class="btn btn-ghost btn-small btn-cancel">Отменить</button>'
      + '</div>'
      + '<div class="mybooking-reschedule-panel" hidden></div>'
      + '<p class="mybooking-status" hidden></p>';

    var statusEl = card.querySelector('.mybooking-status');

    card.querySelector('.btn-cancel').addEventListener('click', function () {
      if (!confirm('Отменить запись на ' + formatDateRu(b.date) + ', ' + b.start + '?')) return;

      callBackend('cancelBookingByPhone', { phone: phone, id: b.id })
        .then(function (res) {
          if (res && res.ok) {
            card.classList.add('is-cancelled');
            card.querySelector('.mybooking-actions').hidden = true;
            setStatus(statusEl, 'Запись отменена', 'success');
            AVAILABILITY = null;
          } else {
            setStatus(statusEl, 'Не получилось отменить. Попробуйте ещё раз.', 'error');
          }
        })
        .catch(function () { setStatus(statusEl, 'Сервер не отвечает.', 'error'); });
    });

    card.querySelector('.btn-reschedule').addEventListener('click', function () {
      var panel = card.querySelector('.mybooking-reschedule-panel');
      if (!panel.hidden) { panel.hidden = true; return; }
      panel.hidden = false;
      buildRescheduleSlots(panel, b, phone, statusEl);
    });

    resultsEl.appendChild(card);
  });
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'mybooking-status ' + kind;
  el.hidden = false;
}

// Перенос — в пределах того же дня и того же мастера. Собственный слот
// брони исключаем из проверки занятости, иначе запись конфликтовала бы
// сама с собой.
function buildRescheduleSlots(panel, booking, phone, statusEl) {
  panel.innerHTML = '<p class="booking-step-hint">Новое время в пределах ' + escapeHtml(formatDateRu(booking.date)) + ':</p><div class="time-picker"></div>';
  var picker = panel.querySelector('.time-picker');

  var duration = timeToMin(booking.end) - timeToMin(booking.start);
  var slots = gridSlotsFor(booking.masterId, booking.date, duration, { start: booking.start, end: booking.end });

  if (!slots.some(function (s) { return s.free; })) {
    picker.innerHTML = '<p class="booking-step-placeholder">На этот день свободного времени не осталось.</p>';
    return;
  }

  slots.forEach(function (slot) {
    var time = slot.time;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'time-slot';
    btn.textContent = time;
    btn.disabled = !slot.free && time !== booking.start;
    if (time === booking.start) btn.classList.add('picked');

    if (!slot.free) { picker.appendChild(btn); return; }

    btn.addEventListener('click', function () {
      callBackend('rescheduleBookingByPhone', { phone: phone, id: booking.id, newStart: time })
        .then(function (res) {
          if (res && res.ok) {
            setStatus(statusEl, 'Перенесено на ' + time + '.', 'success');
            panel.hidden = true;
            AVAILABILITY = null;
          } else if (res && res.error === 'slot-taken') {
            setStatus(statusEl, 'Это время уже заняли. Выберите другое.', 'error');
          } else {
            setStatus(statusEl, 'Не получилось перенести. Попробуйте ещё раз.', 'error');
          }
        })
        .catch(function () { setStatus(statusEl, 'Сервер не отвечает.', 'error'); });
    });

    picker.appendChild(btn);
  });
}
