/* ═════════ ЛИЧНЫЙ КАБИНЕТ ═════════
   Окно из меню аватара: профиль сотрудника, оформление (тема) и безопасность.
   Бэкенд пока отдаёт только /auth/me — смены пароля и списка сеансов на сервере нет, здесь они показаны как будущие функции. */

/* ── Тема: светлая, тёмная или как в системе. Выбор хранится в этом браузере ── */
const THEME_KEY = "deanery.mock.theme";
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
let themePref = "system";
try { themePref = localStorage.getItem(THEME_KEY) || "system"; } catch { /* нет доступа */ }
const applyTheme = () => { document.documentElement.dataset.theme = themePref === "system" ? (darkQuery.matches ? "dark" : "light") : themePref; };
darkQuery.addEventListener("change", () => { if (themePref === "system") applyTheme(); });
applyTheme();
function setTheme(v) {
  themePref = v;
  try { localStorage.setItem(THEME_KEY, v); } catch { /* нет доступа */ }
  // Плавная смена: браузер растворяет старую картинку в новой (где не поддерживается — просто переключаем)
  if (document.startViewTransition && !REDUCED) { const t = document.startViewTransition(applyTheme); t.ready.catch(() => {}); t.finished.catch(() => {}); } else applyTheme();
}

const myLogin = () => ME.email.split("@")[0];
const fullDate = (s) => `${human(s)} ${s.slice(0, 4)}`;
function browserName() {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Браузер";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} · ${os}` : b;
}

const THEMES = [["light", "Светлая"], ["dark", "Тёмная"], ["system", "Как в системе"]];
const PW_FIELDS = [["cur", "Текущий пароль", "current-password"], ["next", "Новый пароль", "new-password"], ["rep", "Повторите новый пароль", "new-password"]];

function accountDialog() {
  const m = { label: "Личный кабинет", tab: "profile", pw: { cur: "", next: "", rep: "" }, errors: {}, busy: false };
  const years = Math.floor((D(TODAY) - D(ME.hire_date)) / (365.25 * 864e5));
  const kv = (label, value) => `<div><small>${label}</small><b>${esc(value)}</b></div>`;

  const profile = () => `<div class="kv-grid acc-kv">
      ${kv("Логин", myLogin())}${kv("Табельный номер", ME.personnel_number)}
      ${kv("Должность", ME.position)}${kv("Подразделение", ME.unit)}
      ${kv("Ставка", String(ME.employment_rate).replace(".", ","))}${kv("Работает с", `${fullDate(ME.hire_date)} · ${years} ${plural(years, "год", "года", "лет")}`)}
      ${kv("Телефон", ME.phone)}${kv("Почта", ME.email)}</div>
    <p class="hint acc-note">Данные ведёт отдел кадров. Если что-то неверно — напишите администратору.</p>`;

  const theme = () => `<div class="theme-opts" role="radiogroup" aria-label="Тема">${THEMES.map(([v, l]) =>
      `<button type="button" class="theme-opt" role="radio" data-a="theme" data-v="${v}" aria-checked="${themePref === v}">
        <span class="theme-pic ${v}" aria-hidden="true"><i></i><i></i><i></i></span><span>${l}</span></button>`).join("")}</div>`;

  const security = () => `<form class="acc-block" data-pwform novalidate>
      <h4>Смена пароля</h4>
      <div class="acc-pw">${PW_FIELDS.map(([n, l, ac]) => `<div class="field form-field${m.errors[n] ? " invalid" : ""}">
        <label for="pw-${n}">${l}</label>
        <input id="pw-${n}" class="text-input" type="password" data-pw="${n}" value="${esc(m.pw[n])}" autocomplete="${ac}" ${m.busy ? "disabled" : ""}>
        ${m.errors[n] ? `<small class="field-error" role="alert">${esc(m.errors[n])}</small>` : n === "next" ? `<small class="hint">Не короче 8 символов</small>` : ""}</div>`).join("")}</div>
      <div><button class="btn sm primary" ${m.busy ? "disabled" : ""}>${m.busy ? "Меняем…" : "Сменить пароль"}</button></div>
    </form>
    <div class="acc-block">
      <h4>Сеансы</h4>
      <div class="acc-session"><span class="dialog-ico sm">${icon("grid")}</span>
        <div><b>${esc(browserName())}</b><small>Этот браузер · вход выполнен сегодня</small></div>${badge("Текущий", "ok")}</div>
      <div><button type="button" class="btn sm ghost danger-text" data-a="logout-all">${icon("logout")}Выйти на всех устройствах</button></div>
    </div>`;

  m.html = () => `<div class="dialog form-dialog account">
    <div class="form-head"><div class="acc-who"><span class="avatar t${tone(ME.full_name)}">${initials(ME.full_name)}</span>
        <div><h3>${esc(ME.full_name)}</h3><p>${ROLE_NAME} · ${esc(myLogin())}</p></div></div>
      <button type="button" class="icon-btn" aria-label="Закрыть" data-a="close">${icon("x")}</button></div>
    <div class="form-body">
      ${seg("acctab", [["profile", "Личные данные"], ["theme", "Оформление"], ["security", "Безопасность"]], m.tab)}
      <div class="acc-panes">${Object.entries({ profile, theme, security }).map(([t, html]) =>
        `<div class="acc-pane${t === m.tab ? " on" : ""}" data-k="p-${t}" ${t === m.tab ? "" : "inert aria-hidden=\"true\""}>${html()}</div>`).join("")}</div>
    </div></div>`;
  m.close = () => closeModal(m);
  m.click = (el) => {
    const a = el.dataset.a;
    if (a === "close") m.close();
    else if (a === "acctab") { m.tab = el.dataset.v; render(); }
    else if (a === "theme") { setTheme(el.dataset.v); render(); }
    else if (a === "logout-all") confirmDialog({ title: "Выйти на всех устройствах?", text: "Понадобится заново войти везде, в том числе в этом браузере.",
      confirm: "Выйти везде", danger: true, onConfirm: () => { closeModal(m); logout(); } });
  };
  m.input = (el) => {
    if (el.dataset.pw == null) return;
    m.pw[el.dataset.pw] = el.value;
    if (m.errors[el.dataset.pw]) { delete m.errors[el.dataset.pw]; render(); }
  };
  m.submit = async (e) => {
    if (!e.target.closest("[data-pwform]") || m.busy) return;
    const { cur, next, rep } = m.pw, err = {};
    if (!cur) err.cur = "Введите текущий пароль";
    if (next.length < 8) err.next = "Не короче 8 символов";
    else if (next === cur) err.next = "Новый пароль совпадает с текущим";
    if (!err.next && rep !== next) err.rep = "Пароли не совпадают";
    m.errors = err;
    if (Object.keys(err).length) { render(); $(`[data-k="${m.key}"] #pw-${Object.keys(err)[0]}`)?.focus(); return; }
    m.busy = true; render();
    await wait(600);   // как запрос к серверу
    Object.assign(m, { busy: false, pw: { cur: "", next: "", rep: "" } });
    render(); toast("Пароль изменён");
  };
  return openModal(m);
}
