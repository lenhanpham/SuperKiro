/*
 * SuperKiro admin UI logic.
 */
(() => {
  'use strict';

  // State
  const baseUrl = location.origin;
  if (localStorage.getItem('kiro_remember') !== '1') {
    localStorage.removeItem('admin_password');
    localStorage.removeItem('admin_login_time');
  }
  let password = sessionStorage.getItem('admin_password') || localStorage.getItem('admin_password') || '';
  let currentLang = localStorage.getItem('kiro_lang') || 'en';
  const dict = { en: null, zh: null };
  let accountsData = [];
  const selectedAccounts = new Set();
  let filterKeyword = '';
  let filterStatus = 'all';
  let privacyModeEnabled = true;
  let promptRules = [];
  let builderIdSession = '';
  let builderIdPollTimer = null;
  let iamSession = '';
  let exportSelectedIds = new Set();
  let currentVersion = '';
  let testLogs = [];
  let testModalAccountId = '';
  let testModalModels = [];
  let testModalLoadingModels = false;
  let testModalModelError = false;
  let testModalRunning = false;
  let customSelectUid = 0;
  let customSelectObserver = null;
  let customSelectRefreshQueued = false;

  // DOM helpers
  const $ = (id) => document.getElementById(id);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }
  async function copyText(input) {
    const isPromise = input && typeof input.then === 'function';
    if (isPromise && typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
      const blobPromise = Promise.resolve(input).then(t => new Blob([String(t == null ? '' : t)], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobPromise })]);
      return;
    }
    const text = isPromise ? await input : input;
    const str = String(text == null ? '' : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(str);
        return;
      } catch (e) { }
    }
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.readOnly = true;
    ta.className = 'clipboard-proxy';
    document.body.appendChild(ta);
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, str.length);
    document.execCommand('copy');
    sel.removeAllRanges();
    document.body.removeChild(ta);
  }
  function renderEndpointCode(id, value) {
    const el = $(id);
    if (!el) return;
    const raw = String(value || '');
    el.dataset.rawValue = raw;
    try {
      const url = new URL(raw);
      const path = url.pathname + url.search + url.hash;
      el.innerHTML =
        '<span class="api-code-protocol">' + escapeHtml(url.protocol + '//') + '</span>' +
        '<span class="api-code-host">' + escapeHtml(url.host) + '</span>' +
        '<span class="api-code-path">' + escapeHtml(path) + '</span>';
    } catch (e) {
      el.textContent = raw;
    }
  }

  // i18n
  async function loadLocale(lang) {
    if (dict[lang]) return dict[lang];
    try {
      const res = await fetch('/admin/locales/' + lang + '.json?v=' + Date.now(), { cache: 'no-store' });
      dict[lang] = await res.json();
    } catch (e) {
      dict[lang] = {};
    }
    return dict[lang];
  }
  function t(key, ...args) {
    const active = dict[currentLang] || {};
    const fallback = dict.zh || {};
    let text = active[key] || fallback[key] || key;
    args.forEach((arg, idx) => { text = text.replace('{' + idx + '}', arg); });
    return text;
  }
  function applyTranslations() {
    qsa('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    qsa('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    qsa('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    qsa('[data-i18n-aria-label]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)); });
    document.title = t('app.title');
    document.documentElement.lang = currentLang;
    updateLangButtons();
    applyTheme(getThemePref());
    refreshCustomSelects();
  }
  async function setLang(lang) {
    currentLang = lang;
    localStorage.setItem('kiro_lang', lang);
    await loadLocale(lang);
    applyTranslations();
    renderVersionBadge();
    renderAccounts();
    renderPromptRules();
  }
  function updateLangButtons() {
    qsa('.lang-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.lang === currentLang));
    qsa('.lang-toggle').forEach(btn => {
      const label = btn.querySelector('.lang-toggle-label');
      if (label) label.textContent = currentLang === 'zh' ? t('lang.zh') : currentLang === 'vi' ? t('lang.vi') : t('lang.en');
    });
  }
  function toggleLang() {
    const order = ['en', 'vi', 'zh'];
    const idx = order.indexOf(currentLang);
    setLang(order[(idx + 1) % order.length]);
  }

  // Custom select
  function getCustomSelectLabel(select) {
    const option = select.selectedOptions && select.selectedOptions[0];
    return ((option && option.textContent) || select.value || '').trim();
  }
  function syncCustomSelect(select) {
    const wrap = select && select.__customSelect;
    if (!wrap) return;
    const value = wrap.querySelector('.custom-select-value');
    const trigger = wrap.querySelector('.custom-select-trigger');
    if (value) value.textContent = getCustomSelectLabel(select);
    if (trigger) trigger.disabled = select.disabled;
    wrap.classList.toggle('is-disabled', select.disabled);
    qsa('.custom-select-option', wrap).forEach(option => {
      const selected = option.dataset.index === String(select.selectedIndex);
      option.classList.toggle('is-selected', selected);
      option.setAttribute('aria-selected', String(selected));
    });
  }
  function renderCustomSelectOptions(select) {
    const wrap = select && select.__customSelect;
    if (!wrap) return;
    const content = wrap.querySelector('.custom-select-content');
    const trigger = wrap.querySelector('.custom-select-trigger');
    if (!content) return;
    if (trigger) labelCustomSelect(select, trigger, content, select.id);
    content.innerHTML = '';
    Array.from(select.options).forEach((option, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'custom-select-option';
      item.setAttribute('role', 'option');
      item.dataset.index = String(index);
      item.disabled = option.disabled;
      item.textContent = (option.textContent || option.value || '').trim();
      content.appendChild(item);
    });
    syncCustomSelect(select);
  }
  function placeCustomSelectContent(select) {
    const wrap = select && select.__customSelect;
    if (!wrap || !wrap.classList.contains('is-open')) return;
    const trigger = wrap.querySelector('.custom-select-trigger');
    const content = wrap.querySelector('.custom-select-content');
    if (!trigger || !content) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const below = window.innerHeight - rect.bottom - gap;
    const above = rect.top - gap;
    const openUp = below < 180 && above > below;
    const available = Math.max(96, Math.min(224, (openUp ? above : below) - 4));
    content.style.left = Math.round(rect.left) + 'px';
    content.style.width = Math.round(rect.width) + 'px';
    content.style.maxHeight = Math.round(available) + 'px';
    content.style.top = openUp ? 'auto' : Math.round(rect.bottom + gap) + 'px';
    content.style.bottom = openUp ? Math.round(window.innerHeight - rect.top + gap) + 'px' : 'auto';
    content.dataset.side = openUp ? 'top' : 'bottom';
  }
  function setCustomSelectOpen(select, open) {
    const wrap = select && select.__customSelect;
    if (!wrap) return;
    const trigger = wrap.querySelector('.custom-select-trigger');
    const content = wrap.querySelector('.custom-select-content');
    if (!trigger || !content) return;
    if (open && !select.disabled) {
      closeAllCustomSelects(select);
      renderCustomSelectOptions(select);
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      content.hidden = false;
      placeCustomSelectContent(select);
      requestAnimationFrame(() => placeCustomSelectContent(select));
      const selected = content.querySelector('.custom-select-option.is-selected:not(:disabled)') || content.querySelector('.custom-select-option:not(:disabled)');
      if (selected) selected.focus({ preventScroll: true });
    } else {
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      content.hidden = true;
    }
  }
  function closeAllCustomSelects(except) {
    qsa('select.custom-select-native').forEach(select => {
      if (select !== except) setCustomSelectOpen(select, false);
    });
  }
  function chooseCustomSelectOption(select, index) {
    const option = select.options[index];
    if (!option || option.disabled) return;
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    syncCustomSelect(select);
    setCustomSelectOpen(select, false);
    const trigger = select.__customSelect && select.__customSelect.querySelector('.custom-select-trigger');
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  }
  function focusSiblingCustomOption(current, dir) {
    const options = qsa('.custom-select-option:not(:disabled)', current.parentElement);
    const index = options.indexOf(current);
    const next = options[(index + dir + options.length) % options.length];
    if (next) next.focus({ preventScroll: true });
  }
  function getCustomSelectLabelElement(select) {
    const explicit = qsa('label').find(label => label.htmlFor === select.id);
    if (explicit) return explicit;
    const group = select.closest('.form-group');
    return group ? group.querySelector('label') : null;
  }
  function labelCustomSelect(select, trigger, content, id) {
    trigger.id = id + '-trigger';
    const valueId = id + '-value';
    const value = trigger.querySelector('.custom-select-value');
    if (value) value.id = valueId;
    const label = getCustomSelectLabelElement(select);
    if (label) {
      if (!label.id) label.id = id + '-label';
      trigger.removeAttribute('aria-label');
      trigger.setAttribute('aria-labelledby', label.id + ' ' + valueId);
    } else {
      trigger.removeAttribute('aria-labelledby');
      trigger.setAttribute('aria-label', select.getAttribute('aria-label') || getCustomSelectLabel(select));
    }
    content.setAttribute('aria-labelledby', trigger.id);
  }
  function enhanceCustomSelect(select) {
    if (!select || select.__customSelect || select.dataset.nativeSelect === 'true') return;

    const id = select.id || 'custom-select-' + (++customSelectUid);
    if (!select.id) select.id = id;

    const wrap = document.createElement('div');
    wrap.className = 'custom-select';
    wrap.dataset.customSelect = 'true';
    if (select.id === 'filterStatusSelect') wrap.classList.add('custom-select-filter');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', id + '-menu');
    trigger.innerHTML =
      '<span class="custom-select-value"></span>' +
      '<i class="fa-solid fa-chevron-down custom-select-icon" aria-hidden="true"></i>';

    const content = document.createElement('div');
    content.id = id + '-menu';
    content.className = 'custom-select-content';
    content.setAttribute('role', 'listbox');
    content.hidden = true;
    labelCustomSelect(select, trigger, content, id);

    wrap.appendChild(trigger);
    wrap.appendChild(content);
    select.insertAdjacentElement('afterend', wrap);
    select.classList.add('custom-select-native');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;
    select.__customSelect = wrap;
    wrap.__nativeSelect = select;

    trigger.addEventListener('click', () => setCustomSelectOpen(select, !wrap.classList.contains('is-open')));
    trigger.addEventListener('keydown', e => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setCustomSelectOpen(select, true);
      }
    });
    content.addEventListener('click', e => {
      const option = e.target.closest('.custom-select-option');
      if (!option) return;
      chooseCustomSelectOption(select, parseInt(option.dataset.index, 10));
    });
    content.addEventListener('keydown', e => {
      const option = e.target.closest('.custom-select-option');
      if (!option) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); focusSiblingCustomOption(option, 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusSiblingCustomOption(option, -1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseCustomSelectOption(select, parseInt(option.dataset.index, 10)); }
      else if (e.key === 'Escape') { e.preventDefault(); setCustomSelectOpen(select, false); trigger.focus({ preventScroll: true }); }
    });
    select.addEventListener('change', () => syncCustomSelect(select));
    renderCustomSelectOptions(select);
  }
  function enhanceCustomSelects(root) {
    qsa('select:not(.custom-select-native)', root || document).forEach(enhanceCustomSelect);
  }
  function refreshCustomSelects(root) {
    enhanceCustomSelects(root);
    qsa('select.custom-select-native', root || document).forEach(renderCustomSelectOptions);
  }
  function positionOpenCustomSelects() {
    qsa('select.custom-select-native').forEach(placeCustomSelectContent);
  }
  function queueCustomSelectRefresh() {
    if (customSelectRefreshQueued) return;
    customSelectRefreshQueued = true;
    requestAnimationFrame(() => {
      customSelectRefreshQueued = false;
      refreshCustomSelects();
      positionOpenCustomSelects();
    });
  }
  function initCustomSelectObserver() {
    if (customSelectObserver || !document.body || typeof MutationObserver === 'undefined') return;
    customSelectObserver = new MutationObserver(mutations => {
      let shouldRefresh = false;
      for (const mutation of mutations) {
        const target = mutation.target;
        if (target && target.closest && target.closest('.custom-select')) continue;
        if (target && target.matches && target.matches('select')) {
          shouldRefresh = true;
          break;
        }
        for (const node of mutation.addedNodes || []) {
          if (node.nodeType !== 1) continue;
          if ((node.matches && node.matches('select')) || (node.querySelector && node.querySelector('select'))) {
            shouldRefresh = true;
            break;
          }
        }
        if (shouldRefresh) break;
      }
      if (shouldRefresh) queueCustomSelectRefresh();
    });
    customSelectObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'class', 'id', 'data-native-select']
    });
  }

  // Theme
  const THEME_ORDER = ['system', 'light', 'dark'];
  const themeMQ = window.matchMedia('(prefers-color-scheme: dark)');
  function resolveTheme(pref) {
    if (pref === 'dark') return 'dark';
    if (pref === 'light') return 'light';
    return themeMQ.matches ? 'dark' : 'light';
  }
  function applyTheme(pref) {
    const resolved = resolveTheme(pref);
    const root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    root.dataset.themePref = pref;
    qsa('.theme-toggle').forEach(btn => {
      btn.dataset.theme = pref;
      const themeLabel = t('theme.status', t('theme.' + pref));
      btn.setAttribute('aria-label', themeLabel);
      btn.setAttribute('title', themeLabel);
    });
  }
  function getThemePref() {
    const saved = localStorage.getItem('kiro_theme');
    return THEME_ORDER.includes(saved) ? saved : 'system';
  }
  function initTheme() {
    applyTheme(getThemePref());
    themeMQ.addEventListener('change', () => {
      if (getThemePref() === 'system') applyTheme('system');
    });
  }
  function toggleTheme() {
    const cur = getThemePref();
    const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    localStorage.setItem('kiro_theme', next);
    applyTheme(next);
  }

  // Privacy and email mask
  function initPrivacyMode() {
    const saved = localStorage.getItem('privacyMode');
    privacyModeEnabled = saved === null ? true : saved === 'true';
    const toggle = $('privacyModeToggle');
    if (toggle) toggle.checked = privacyModeEnabled;
  }
  function maskEmail(email) {
    if (!privacyModeEnabled || !email || email.indexOf('@') === -1) return email;
    const [local, domain] = email.split('@');
    const maskedLocal = local.length <= 2 ? local : local.substring(0, 2) + '***';
    const parts = domain.split('.');
    if (parts.length >= 2) {
      const tld = parts[parts.length - 1];
      const sld = parts[parts.length - 2];
      const maskedSld = sld.length <= 2 ? sld : sld.substring(0, 2) + '***';
      const subs = parts.slice(0, -2).map(s => s.length <= 2 ? s : s.substring(0, 2) + '***');
      return maskedLocal + '@' + [...subs, maskedSld, tld].join('.');
    }
    return maskedLocal + '@' + domain;
  }
  function getDisplayEmail(email, id) {
    const raw = email || (id ? id.substring(0, 12) + '...' : '-');
    return maskEmail(raw);
  }

  // Toast bridge
  const toast = function (msg, variant, opts) {
    if (typeof window.toast === 'function') return window.toast(msg, variant, opts);
    try { console.warn('[toast missing]', variant, msg); } catch (_) { }
    return function () {};
  };
  const toastPrimary = (msg, opts) => toast(msg, 'primary', opts);
  const toastWarning = (msg, opts) => toast(msg, 'warning', opts);
  const toastError = (msg, opts) => toast(msg, 'error', opts);

  // Modal helpers
  let modalScrollY = 0;
  let confirmResolve = null;
  const modalFocusStack = [];
  function lockModalScroll() {
    if (document.body.classList.contains('modal-open')) return;
    modalScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    document.body.style.top = '-' + modalScrollY + 'px';
    document.body.classList.add('modal-open');
  }
  function unlockModalScrollIfIdle() {
    if (qsa('.modal.active').length > 0) return;
    if (!document.body.classList.contains('modal-open')) return;
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo(0, modalScrollY);
  }
  function getModalFocusable(modal) {
    return qsa('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', modal)
      .filter(el => !el.closest('[hidden]'));
  }
  function prepareDialog(modal) {
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-hidden', 'false');
    if (!modal.hasAttribute('tabindex')) modal.tabIndex = -1;
    const title = modal.querySelector('.modal-title');
    if (title) {
      if (!title.id) title.id = modal.id + 'Title';
      modal.setAttribute('aria-labelledby', title.id);
    }
  }
  function focusDialog(modal) {
    if (modal.contains(document.activeElement) && document.activeElement !== modal) return;
    const focusable = getModalFocusable(modal);
    const target = focusable[0] || modal;
    if (target && target.focus) target.focus({ preventScroll: true });
  }
  function trapDialogFocus(e) {
    const modal = e.currentTarget;
    if (e.key !== 'Tab' || !modal.classList.contains('active')) return;
    const focusable = getModalFocusable(modal);
    if (!focusable.length) {
      e.preventDefault();
      modal.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  }
  function openDialog(id) {
    const modal = $(id);
    if (!modal) return;
    prepareDialog(modal);
    modalFocusStack.push({ id, el: document.activeElement });
    modal.removeEventListener('keydown', trapDialogFocus);
    modal.addEventListener('keydown', trapDialogFocus);
    modal.classList.add('active');
    lockModalScroll();
    focusDialog(modal);
    setTimeout(() => focusDialog(modal), 0);
  }
  function closeDialog(id) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    const stackIndex = modalFocusStack.map(item => item.id).lastIndexOf(id);
    const previous = stackIndex >= 0 ? modalFocusStack.splice(stackIndex, 1)[0].el : null;
    unlockModalScrollIfIdle();
    if (previous && previous.isConnected && previous.focus) {
      requestAnimationFrame(() => previous.focus({ preventScroll: true }));
    }
  }
  function bindDialogBackdropClose(id, closeFn) {
    const modal = $(id);
    if (!modal) return;
    let startedOnBackdrop = false;
    modal.addEventListener('pointerdown', e => {
      startedOnBackdrop = e.target === modal;
    });
    modal.addEventListener('click', e => {
      if (startedOnBackdrop && e.target === modal) closeFn();
      startedOnBackdrop = false;
    });
  }
  function closeConfirm(value) {
    if (!confirmResolve) return;
    const resolve = confirmResolve;
    confirmResolve = null;
    closeDialog('confirmModal');
    resolve(!!value);
  }
  function confirmAction(message, opts) {
    opts = opts || {};
    if (confirmResolve) closeConfirm(false);
    const modal = $('confirmModal');
    const title = $('confirmTitle');
    const msg = $('confirmMessage');
    const ok = $('confirmOk');
    const cancel = $('confirmCancel');
    const close = $('confirmClose');
    if (!modal || !title || !msg || !ok || !cancel || !close) {
      return Promise.resolve(false);
    }
    title.textContent = opts.title || t('common.confirm');
    msg.textContent = message || '';
    ok.textContent = opts.confirmText || t('common.confirm');
    cancel.textContent = opts.cancelText || t('common.cancel');
    ok.className = 'btn ' + (opts.variant === 'danger' ? 'btn-danger' : 'btn-primary');
    cancel.className = 'btn btn-secondary';
    ok.onclick = () => closeConfirm(true);
    cancel.onclick = () => closeConfirm(false);
    close.onclick = () => closeConfirm(false);
    const pending = new Promise(resolve => { confirmResolve = resolve; });
    openDialog('confirmModal');
    ok.focus({ preventScroll: true });
    return pending;
  }

  // Fetch wrapper
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Admin-Password': password }, opts.headers || {});
    if (opts.body && !opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
    return fetch('/admin/api' + path, opts).then(function(res) {
      var backupFile = res.headers.get('X-Cli-Backup');
      if (backupFile) {
        setTimeout(function() {
          toast(t('cliTools.backupCreated') + '\n' + backupFile, 'info', { duration: 6000 });
        }, 100);
      }
      return res;
    });
  }

  // Login
  function clearActivePassword() {
    sessionStorage.removeItem('admin_password');
    sessionStorage.removeItem('admin_login_time');
    localStorage.removeItem('admin_password');
    localStorage.removeItem('admin_login_time');
    password = '';
  }
  function getActiveLoginTime() {
    const storage = sessionStorage.getItem('admin_password') ? sessionStorage : localStorage;
    return parseInt(storage.getItem('admin_login_time') || '0', 10);
  }
  function setActivePassword(nextPassword, remember) {
    const now = Date.now().toString();
    password = nextPassword;
    sessionStorage.setItem('admin_password', nextPassword);
    sessionStorage.setItem('admin_login_time', now);
    if (remember) {
      localStorage.setItem('admin_password', nextPassword);
      localStorage.setItem('admin_login_time', now);
      localStorage.setItem('kiro_remember', '1');
      localStorage.setItem('kiro_remembered_pwd', nextPassword);
    } else {
      localStorage.removeItem('admin_password');
      localStorage.removeItem('admin_login_time');
      localStorage.removeItem('kiro_remember');
      localStorage.removeItem('kiro_remembered_pwd');
    }
  }
  async function tryAutoLogin() {
    if (!password) return;
    const loginTime = getActiveLoginTime();
    if (loginTime && Date.now() - loginTime > 72 * 3600 * 1000) {
      clearActivePassword();
      return;
    }
    try {
      const res = await api('/status');
      if (res.ok) { showMain(); loadData(); }
    } catch (e) { }
  }
  async function login() {
    password = $('pwdField').value;
    try {
      const res = await api('/status');
      if (res.ok) {
        const remember = $('rememberPwd');
        setActivePassword(password, !!(remember && remember.checked));
        showMain(); loadData();
      } else {
        toast(t('login.error'), 'error');
      }
    } catch (e) {
      toast(t('login.connectError'), 'error');
    }
  }
  function initRememberMe() {
    const remember = $('rememberPwd');
    const field = $('pwdField');
    if (!remember || !field) return;
    if (localStorage.getItem('kiro_remember') === '1') {
      remember.checked = true;
      const saved = localStorage.getItem('kiro_remembered_pwd');
      if (saved) field.value = saved;
    }
  }
  function logout() {
    clearActivePassword();
    location.reload();
  }
  function showMain() {
    $('loginPage').classList.add('hidden');
    $('mainPage').classList.remove('hidden');
  }

  // Data loaders
  async function loadData() {
    await Promise.all([loadStats(), loadAccounts(), loadSettings(), loadVersion(), loadApiKeys()]);
    renderEndpointCode('claudeEndpoint', baseUrl + '/v1/messages');
    renderEndpointCode('openaiEndpoint', baseUrl + '/v1/chat/completions');
    renderEndpointCode('openaiResponsesEndpoint', baseUrl + '/v1/responses');
    renderEndpointCode('modelsEndpoint', baseUrl + '/v1/models');
    renderEndpointCode('statsEndpoint', baseUrl + '/v1/stats');
    setTimeout(checkUpdate, 2000);
  }
  async function loadStats() {
    const res = await api('/status');
    const d = await res.json();
    $('statAccounts').textContent = d.accounts || 0;
    $('statRequests').textContent = d.totalRequests || 0;
    $('statSuccess').textContent = d.successRequests || 0;
    $('statFailed').textContent = d.failedRequests || 0;
    $('statTokens').textContent = formatNum(d.totalTokens || 0);
    $('statCredits').textContent = (d.totalCredits || 0).toFixed(1);
  }
  async function loadAccounts() {
    const res = await api('/accounts');
    accountsData = await res.json();
    renderAccounts();
  }

  // Account list
  function getFilteredAccounts() {
    return accountsData.filter(a => {
      if (filterStatus === 'enabled' && !a.enabled) return false;
      if (filterStatus === 'disabled' && (a.enabled || (a.banStatus && a.banStatus !== 'ACTIVE'))) return false;
      if (filterStatus === 'banned' && (!a.banStatus || a.banStatus === 'ACTIVE')) return false;
      if (filterKeyword) {
        const kw = filterKeyword.toLowerCase();
        if (!(a.email || '').toLowerCase().includes(kw)) return false;
      }
      return true;
    });
  }
  function onFilterChange() {
    filterKeyword = $('filterSearch').value;
    filterStatus = $('filterStatusSelect').value;
    renderAccounts();
  }
  function toggleSelectAll(checked) {
    const filtered = getFilteredAccounts();
    if (checked) filtered.forEach(a => selectedAccounts.add(a.id));
    else selectedAccounts.clear();
    renderAccounts();
    updateBatchBar();
  }
  function toggleSelectAccount(id) {
    if (selectedAccounts.has(id)) selectedAccounts.delete(id);
    else selectedAccounts.add(id);
    updateBatchBar();
  }
  function updateBatchBar() {
    const bar = $('batchBar');
    const count = selectedAccounts.size;
    const cb = $('selectAllCheckbox');
    if (cb) {
      const filtered = getFilteredAccounts();
      const selectedFiltered = filtered.filter(a => selectedAccounts.has(a.id)).length;
      cb.checked = filtered.length > 0 && selectedFiltered === filtered.length;
      cb.indeterminate = selectedFiltered > 0 && selectedFiltered < filtered.length;
    }
    if (count > 0) {
      bar.classList.remove('hidden');
      $('batchCount').textContent = String(count);
    } else {
      bar.classList.add('hidden');
    }
  }

  function formatSubscriptionLabel(type) {
    const s = (type || '').toUpperCase();
    if (s.includes('POWER')) return t('subscription.power');
    if (s.includes('PRO_PLUS') || s.includes('PROPLUS')) return t('subscription.proPlus');
    if (s.includes('PRO')) return t('subscription.pro');
    if (s.includes('FREE')) return t('subscription.free');
    return type || t('subscription.free');
  }
  function getSubBadge(type) {
    const s = (type || '').toUpperCase();
    if (s.includes('POWER')) return '<span class="badge badge-power">' + escapeHtml(formatSubscriptionLabel(type)) + '</span>';
    if (s.includes('PRO_PLUS') || s.includes('PROPLUS')) return '<span class="badge badge-proplus">' + escapeHtml(formatSubscriptionLabel(type)) + '</span>';
    if (s.includes('PRO')) return '<span class="badge badge-pro">' + escapeHtml(formatSubscriptionLabel(type)) + '</span>';
    return '<span class="badge badge-free">' + escapeHtml(formatSubscriptionLabel(type)) + '</span>';
  }
  function getTrialBadge(a) {
    if (a.trialStatus === 'ACTIVE' && a.trialUsageLimit > 0) {
      return '<span class="badge badge-trial">' + escapeHtml(t('accounts.trial')) + '</span>';
    }
    return '';
  }
  function formatTrialExpiry(ts) {
    if (!ts) return '';
    const date = new Date(ts * 1000);
    const diffDays = Math.ceil((date - new Date()) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return '(' + t('accounts.trialExpired') + ')';
    if (diffDays === 0) return '(' + t('accounts.trialToday') + ')';
    if (diffDays <= 7) return '(' + diffDays + t('accounts.trialDays') + ')';
    return '';
  }
  function formatAuthMethod(method) {
    if (!method) return '-';
    const normalized = String(method).toLowerCase();
    if (normalized === 'idc') return t('auth.enterprise');
    if (normalized === 'social') return t('auth.social');
    if (normalized === 'builderid') return 'BuilderID';
    if (normalized === 'github') return t('local.providerGithub');
    if (normalized === 'google') return t('local.providerGoogle');
    return method;
  }
  function getStatusBadge(a) {
    const out = [];
    const isBanned = a.banStatus && a.banStatus !== 'ACTIVE';
    if (isBanned) {
      if (a.banStatus === 'BANNED') out.push('<span class="badge badge-banned">' + escapeHtml(t('accounts.banned')) + '</span>');
      else if (a.banStatus === 'SUSPENDED') out.push('<span class="badge badge-suspended">' + escapeHtml(t('accounts.suspended')) + '</span>');
      out.push('<span class="badge badge-warning">' + escapeHtml(t('accounts.disabled')) + '</span>');
    } else {
      if (!a.hasToken)
        out.push('<span class="badge badge-error">' + escapeHtml(t('accounts.noToken')) + '</span>');
      else if (a.expiresAt && a.expiresAt < Date.now() / 1000)
        out.push('<span class="badge badge-warning">' + escapeHtml(t('accounts.expired')) + '</span>');
      else
        out.push('<span class="badge badge-success">' + escapeHtml(t('accounts.normal')) + '</span>');
      out.push(a.enabled
        ? '<span class="badge badge-info">' + escapeHtml(t('accounts.enabled')) + '</span>'
        : '<span class="badge badge-warning">' + escapeHtml(t('accounts.disabled')) + '</span>');
    }
    return out.join('');
  }
  function formatTokenExpiry(ts) {
    if (!ts) return '-';
    const diff = ts - Date.now() / 1000;
    if (diff <= 0) return t('time.expired');
    if (diff < 3600) return Math.floor(diff / 60) + t('time.minutes');
    if (diff < 86400) return Math.floor(diff / 3600) + t('time.hours');
    return Math.floor(diff / 86400) + t('time.days');
  }
  function formatNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toString();
  }
  function applyUsageBars(root) {
    qsa('.usage-fill[data-usage-pct]', root).forEach(el => {
      const pct = Math.max(0, Math.min(100, parseFloat(el.dataset.usagePct) || 0));
      el.style.width = pct + '%';
    });
  }

  function renderAccounts() {
    const container = $('accountsList');
    if (!container) return;
    const filtered = getFilteredAccounts();
    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state">' + escapeHtml(t('accounts.empty')) + '</div>';
      return;
    }
    container.innerHTML = filtered.map(a => {
      const usagePct = (a.usagePercent || 0) * 100;
      const usageClass = usagePct > 90 ? 'critical' : usagePct > 70 ? 'high' : '';
      const trialPct = (a.trialUsagePercent || 0) * 100;
      const trialClass = trialPct > 90 ? 'critical' : trialPct > 70 ? 'high' : '';
      const isSelected = selectedAccounts.has(a.id);
      const weight = a.weight || 0;
      const weightBadge = weight >= 2 ? '<span class="badge badge-warning">' + escapeHtml(t('accounts.weightShort')) + ':' + weight + '</span>' : '';
      const overageBadge = renderOverageBadge(a);
      const banned = a.banStatus && a.banStatus !== 'ACTIVE';
      const idAttr = escapeAttr(a.id);
      const displayEmail = getDisplayEmail(a.email, a.id);
      const selectLabel = t('accounts.selectAccount', displayEmail);

      const refreshSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
      const userSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
      const copySvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

      return '' +
        '<div class="account-card' + (isSelected ? ' selected' : '') + '" data-id="' + idAttr + '">' +
        '<div class="account-header">' +
        '<div class="account-info">' +
        '<input type="checkbox" class="account-checkbox" ' + (isSelected ? 'checked' : '') + ' data-id="' + idAttr + '" aria-label="' + escapeAttr(selectLabel) + '" />' +
        '<div class="account-info-text">' +
        '<div class="account-email">' + escapeHtml(displayEmail) + '</div>' +
        '<div class="account-meta">' +
        getSubBadge(a.subscriptionType) +
        getTrialBadge(a) +
        weightBadge +
        overageBadge +
        '<span class="badge badge-info">' + escapeHtml(formatAuthMethod(a.provider || a.authMethod)) + '</span>' +
        getStatusBadge(a) +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div class="account-actions">' +
        '<button class="btn btn-icon btn-sm btn-ghost" data-action="refresh" data-id="' + idAttr + '" title="' + escapeAttr(t('accounts.refresh')) + '">' + refreshSvg + '</button>' +
        '<button class="btn btn-icon btn-sm btn-ghost" data-action="detail" data-id="' + idAttr + '" title="' + escapeAttr(t('accounts.detail')) + '">' + userSvg + '</button>' +
        '<button class="btn btn-icon btn-sm btn-ghost" data-action="copyJSON" data-id="' + idAttr + '" title="' + escapeAttr(t('accounts.copyJSON')) + '">' + copySvg + '</button>' +
        (banned ? '' :
          '<button class="btn btn-sm ' + (a.enabled ? 'btn-outline' : 'btn-primary') + '" data-action="toggle" data-id="' + idAttr + '" data-enabled="' + (!a.enabled) + '">' +
          escapeHtml(a.enabled ? t('accounts.disable') : t('accounts.enable')) +
          '</button>') +
        '<button class="btn btn-sm btn-secondary" data-action="test" data-id="' + idAttr + '" id="test-' + idAttr + '">' + escapeHtml(t('accounts.test')) + '</button>' +
        '<button class="btn btn-sm btn-danger" data-action="delete" data-id="' + idAttr + '">' + escapeHtml(t('accounts.delete')) + '</button>' +
        '</div>' +
        '</div>' +
        (a.usageLimit > 0 ?
          '<div class="account-usage">' +
          '<div class="usage-label">' + escapeHtml(t('accounts.mainQuota')) + '</div>' +
          '<div class="usage-bar"><div class="usage-fill ' + usageClass + '" data-usage-pct="' + escapeAttr(usagePct) + '"></div></div>' +
          '<div class="usage-text"><span>' + (a.usageCurrent != null ? a.usageCurrent.toFixed(1) : 0) + ' / ' + (a.usageLimit != null ? a.usageLimit.toFixed(0) : 0) + '</span><span>' + usagePct.toFixed(1) + '%</span></div>' +
          '</div>' : '') +
        (a.trialUsageLimit > 0 ?
          '<div class="account-usage">' +
          '<div class="usage-label">' + escapeHtml(t('accounts.trialQuota')) + ' ' + escapeHtml(formatTrialExpiry(a.trialExpiresAt)) + '</div>' +
          '<div class="usage-bar"><div class="usage-fill ' + trialClass + '" data-usage-pct="' + escapeAttr(trialPct) + '"></div></div>' +
          '<div class="usage-text"><span>' + (a.trialUsageCurrent != null ? a.trialUsageCurrent.toFixed(1) : 0) + ' / ' + (a.trialUsageLimit != null ? a.trialUsageLimit.toFixed(0) : 0) + '</span><span>' + trialPct.toFixed(1) + '%</span></div>' +
          '</div>' : '') +
        '<div class="account-stats">' +
        '<div class="account-stat"><div class="account-stat-value">' + (a.requestCount || 0) + '</div><div class="account-stat-label">' + escapeHtml(t('accounts.requests')) + '</div></div>' +
        '<div class="account-stat"><div class="account-stat-value">' + formatNum(a.totalTokens || 0) + '</div><div class="account-stat-label">' + escapeHtml(t('accounts.tokens')) + '</div></div>' +
        '<div class="account-stat"><div class="account-stat-value">' + (a.totalCredits || 0).toFixed(1) + '</div><div class="account-stat-label">' + escapeHtml(t('accounts.credits')) + '</div></div>' +
        '<div class="account-stat"><div class="account-stat-value">' + escapeHtml(formatTokenExpiry(a.expiresAt)) + '</div><div class="account-stat-label">' + escapeHtml(t('accounts.expiry')) + '</div></div>' +
        '</div>' +
        '</div>';
    }).join('');
    applyUsageBars(container);
    enhanceCustomSelects(container);
  }

  // Account actions
  async function refreshAccount(id, card) {
    if (card) card.classList.add('loading');
    try {
      const res = await api('/accounts/' + id + '/refresh', { method: 'POST' });
      const d = await res.json();
      if (d.success) loadAccounts();
      else toastError(t('accounts.refreshFailed') + ': ' + (d.error || ''));
    } catch (e) {
      toastError(t('accounts.refreshFailed'));
    }
    if (card) card.classList.remove('loading');
  }
  async function toggleAccount(id, enabled) {
    await api('/accounts/' + id, { method: 'PUT', body: JSON.stringify({ enabled }) });
    loadAccounts();
  }
  async function deleteAccount(id) {
    const ok = await confirmAction(t('accounts.confirmDelete'), {
      title: t('accounts.delete'),
      confirmText: t('accounts.delete'),
      variant: 'danger'
    });
    if (!ok) return;
    try {
      const res = await api('/accounts/' + id, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.success === false) throw new Error(d.error || t('common.failed'));
      toast(t('accounts.deleteSuccess'), 'danger', { icon: 'fa-solid fa-trash' });
      loadAccounts(); loadStats();
    } catch (e) {
      toast((e && e.message) || t('common.failed'), 'error');
    }
  }
  async function copyAccountJSON(id, btn) {
    try {
      const jsonPromise = api('/accounts/' + id + '/full').then(async res => {
        if (!res.ok) throw new Error('Failed');
        const a = await res.json();
        const { clientId, clientSecret, accessToken, refreshToken } = a;
        return JSON.stringify({ clientId, clientSecret, accessToken, refreshToken }, null, 2);
      });
      await copyText(jsonPromise);
      flashCopySuccess(btn);
      toastPrimary(t('accounts.copyJSONSuccess'));
    } catch (e) {
      toastError(t('common.failed'));
    }
  }
  function flashCopySuccess(btn) {
    if (!btn) return;
    const html = btn.innerHTML, cls = btn.className;
    btn.disabled = true;
    btn.className = 'btn btn-icon btn-sm btn-success';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(() => { btn.disabled = false; btn.className = cls; btn.innerHTML = html; }, 800);
  }

  // Batch actions
  async function batchAction(action) {
    const ids = Array.from(selectedAccounts);
    if (!ids.length) return;
    const confirmKey = 'batch.confirm' + action.charAt(0).toUpperCase() + action.slice(1);
    const ok = await confirmAction(t(confirmKey, ids.length), {
      title: t('common.confirm'),
      confirmText: t('common.confirm'),
      variant: action === 'disable' ? 'danger' : 'primary'
    });
    if (!ok) return;
    const dismiss = toast(t('batch.processing'), 'info', { duration: 0 });
    try {
      const res = await api('/accounts/batch', { method: 'POST', body: JSON.stringify({ ids, action }) });
      const d = await res.json();
      if (!res.ok || !d.success) throw new Error(d.error || t('common.failed'));
      dismiss();
      if (action === 'refresh') {
        toast(t('batch.refreshResult', d.refreshed || 0, d.failed || 0), d.failed ? 'warning' : 'success');
      } else if (action === 'enable') {
        toast(t('batch.enableResult', d.count || ids.length), 'success');
      } else if (action === 'disable') {
        toast(t('batch.disableResult', d.count || ids.length), 'success');
      } else {
        toast(t('batch.done'), 'success');
      }
      selectedAccounts.clear();
      updateBatchBar();
      loadAccounts(); loadStats();
    } catch (e) {
      dismiss();
      toast((e && e.message) || t('common.failed'), 'error');
    }
  }
  async function batchRefreshModels() {
    const ids = Array.from(selectedAccounts);
    if (!ids.length) return;
    const confirmed = await confirmAction(t('batch.confirmRefreshModels', ids.length), {
      title: t('models.refreshAll'),
      confirmText: t('common.confirm')
    });
    if (!confirmed) return;
    const dismiss = toast(t('detail.refreshModelCache') + '…', 'info', { duration: 0 });
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        const res = await api('/accounts/' + id + '/models/refresh', { method: 'POST' });
        const d = await res.json();
        if (d.success) ok++; else fail++;
      } catch { fail++; }
    }
    dismiss();
    toast(t('batch.refreshModelsResult', ok, fail), fail ? 'warning' : 'success');
    selectedAccounts.clear();
    updateBatchBar();
    loadAccounts();
  }
  async function batchDelete() {
    const ids = Array.from(selectedAccounts);
    if (!ids.length) return;
    const confirmed = await confirmAction(t('batch.confirmDelete', ids.length), {
      title: t('accounts.delete'),
      confirmText: t('accounts.delete'),
      variant: 'danger'
    });
    if (!confirmed) return;
    const dismiss = toast(t('batch.deleting'), 'info', { duration: 0 });
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        const res = await api('/accounts/' + id, { method: 'DELETE' });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.success !== false) ok++; else fail++;
      } catch { fail++; }
    }
    dismiss();
    toast(t('batch.deleteResult', ok, fail), fail ? 'warning' : 'success', { icon: 'fa-solid fa-trash' });
    selectedAccounts.clear();
    updateBatchBar();
    loadAccounts(); loadStats();
  }
  async function refreshAllModels() {
    const ok = await confirmAction(t('models.confirmRefreshAll'), {
      title: t('models.refreshAll'),
      confirmText: t('models.refreshAll')
    });
    if (!ok) return;
    const dismiss = toast(t('detail.refreshModelCache') + '…', 'info', { duration: 0 });
    try {
      const res = await api('/accounts/models/refresh', { method: 'POST' });
      const d = await res.json();
      dismiss();
      toast(t('models.refreshAllDone', d.refreshed || 0), 'success');
    } catch (e) {
      dismiss();
      toast(t('common.failed'), 'error');
    }
  }
  async function refreshAccountModels(id) {
    const dismiss = toast(t('detail.refreshModelCache') + '…', 'info', { duration: 0 });
    try {
      const res = await api('/accounts/' + id + '/models/refresh', { method: 'POST' });
      const d = await res.json();
      dismiss();
      if (d.success) toast(t('detail.refreshModelCache') + ' · ' + (d.count || 0), 'success');
      else toast(t('common.failed') + (d.error ? ': ' + d.error : ''), 'error');
    } catch (e) {
      dismiss();
      toast(t('common.failed'), 'error');
    }
  }

  // Detail modal
  function detailItem(label, value) {
    return '<div class="detail-item"><div class="detail-label">' + escapeHtml(label) + '</div><div class="detail-value">' + escapeHtml(value) + '</div></div>';
  }
  function showDetail(id) {
    const a = accountsData.find(x => x.id === id);
    if (!a) return;
    const idAttr = escapeAttr(id);
    $('detailBody').innerHTML =
      '<div class="detail-section"><h4>' + escapeHtml(t('detail.basicInfo')) + '</h4><div class="detail-grid">' +
      detailItem(t('detail.email'), getDisplayEmail(a.email, null)) +
      detailItem(t('detail.userId'), a.userId || '-') +
      detailItem(t('detail.authMethod'), formatAuthMethod(a.provider || a.authMethod)) +
      detailItem(t('detail.region'), a.region || 'us-east-1') +
      '</div></div>' +

      '<div class="detail-section"><h4>' + escapeHtml(t('detail.machineId')) + '</h4><div class="machine-id-row">' +
      '<input type="text" id="machineIdInput" value="' + escapeAttr(a.machineId || '') + '" placeholder="UUID" />' +
      '<button class="btn btn-sm btn-outline" id="generateMachineIdBtn" type="button">' + escapeHtml(t('detail.generate')) + '</button>' +
      '<button class="btn btn-sm btn-primary" data-detail-action="saveMachineId" data-id="' + idAttr + '" type="button">' + escapeHtml(t('detail.save')) + '</button>' +
      '</div></div>' +

      '<div class="detail-section"><h4>' + escapeHtml(t('detail.weight')) + '</h4>' +
      '<div class="form-group">' +
      '<input type="number" id="weightInput" value="' + (a.weight || 0) + '" min="0" max="10" />' +
      '<small>' + escapeHtml(t('detail.weightHint')) + '</small>' +
      '</div>' +
      '<button class="btn btn-sm btn-primary" data-detail-action="saveWeight" data-id="' + idAttr + '" type="button">' + escapeHtml(t('detail.save')) + '</button>' +
      '</div>' +

      '<div class="detail-section">' +
      '<h4>' + escapeHtml(t('detail.overage')) +
      ' <button class="btn btn-sm btn-outline" data-detail-action="refreshOverage" data-id="' + idAttr + '" type="button">' + escapeHtml(t('detail.overageRefresh')) + '</button>' +
      '</h4>' +
      '<p class="help-block">' + escapeHtml(t('detail.overageHint')) + '</p>' +
      renderOverageBlock(a, idAttr) +
      '</div>' +

      '<div class="detail-section"><h4>' + escapeHtml(t('detail.proxyURL')) + '</h4><div class="machine-id-row">' +
      '<input type="text" id="proxyURLInput" value="' + escapeAttr(a.proxyURL || '') + '" placeholder="socks5://host:port" />' +
      '<button class="btn btn-sm btn-primary" data-detail-action="saveProxyURL" data-id="' + idAttr + '" type="button">' + escapeHtml(t('detail.save')) + '</button>' +
      '</div><p class="help-block">' + escapeHtml(t('detail.proxyHint')) + '</p></div>' +

      '<div class="detail-section"><h4>' + escapeHtml(t('detail.subscription')) + '</h4><div class="detail-grid">' +
      detailItem(t('detail.subscriptionType'), a.subscriptionTitle || (a.subscriptionType ? formatSubscriptionLabel(a.subscriptionType) : '-')) +
      detailItem(t('detail.tokenExpiry'), a.expiresAt ? new Date(a.expiresAt * 1000).toLocaleString() : '-') +
      detailItem(t('detail.mainQuota'), (a.usageCurrent != null ? a.usageCurrent.toFixed(1) : 0) + ' / ' + (a.usageLimit != null ? a.usageLimit.toFixed(0) : 0)) +
      detailItem(t('detail.resetDate'), a.nextResetDate || '-') +
      (a.trialUsageLimit > 0 ?
        detailItem(t('detail.trialQuota'), (a.trialUsageCurrent != null ? a.trialUsageCurrent.toFixed(1) : 0) + ' / ' + a.trialUsageLimit.toFixed(0)) +
        detailItem(t('detail.trialStatus'), a.trialStatus || '-') +
        detailItem(t('detail.trialExpiry'), a.trialExpiresAt ? new Date(a.trialExpiresAt * 1000).toLocaleString() : '-')
        : '') +
      '</div></div>' +

      '<div class="detail-section"><h4>' + escapeHtml(t('detail.statistics')) + '</h4><div class="detail-grid">' +
      detailItem(t('detail.requestCount'), a.requestCount || 0) +
      detailItem(t('detail.errorCount'), a.errorCount || 0) +
      detailItem(t('detail.totalTokens'), formatNum(a.totalTokens || 0)) +
      detailItem(t('detail.totalCredits'), (a.totalCredits || 0).toFixed(2)) +
      '</div></div>' +

      '<div class="detail-section">' +
      '<h4>' + escapeHtml(t('detail.models')) +
      ' <button class="btn btn-sm btn-outline" data-detail-action="loadModels" data-id="' + idAttr + '" type="button">' + escapeHtml(t('detail.loadModels')) + '</button>' +
      ' <button class="btn btn-sm btn-outline" data-detail-action="refreshModels" data-id="' + idAttr + '" type="button">' + escapeHtml(t('detail.refreshModelCache')) + '</button>' +
      '</h4>' +
      '<div id="modelsList" class="model-list"></div>' +
      '</div>';

    openDialog('detailModal');
  }
  async function loadModels(id) {
    const c = $('modelsList');
    c.innerHTML = '<p class="empty-state">' + escapeHtml(t('detail.loading')) + '</p>';
    try {
      const res = await api('/accounts/' + id + '/models');
      const d = await res.json();
      if (d.success && d.models) {
        const sorted = d.models.slice().sort((a, b) => {
          if (a.modelId === 'auto') return -1;
          if (b.modelId === 'auto') return 1;
          return (a.rateMultiplier || 1) - (b.rateMultiplier || 1);
        });
        c.innerHTML = sorted.map(m => {
          const ratio = m.rateMultiplier || 1;
          return '<div class="model-item">' +
            '<div class="model-name">' + escapeHtml(m.modelId) + '</div>' +
            '<div class="model-credit"><span class="credit-ratio">' + escapeHtml(t('detail.creditMultiplier', ratio)) + '</span></div>' +
            '<div class="model-info">' + escapeHtml(m.description || '') + '</div>' +
            '</div>';
        }).join('') || '<p class="empty-state">' + escapeHtml(t('detail.noModels')) + '</p>';
      } else {
        c.innerHTML = '<p class="message message-error">' + escapeHtml(t('detail.loadFailed')) + ': ' + escapeHtml(d.error || '') + '</p>';
        toast(t('detail.loadFailed') + (d.error ? ': ' + d.error : ''), 'error');
      }
    } catch (e) {
      c.innerHTML = '<p class="message message-error">' + escapeHtml(t('detail.loadFailed')) + '</p>';
      toast(t('detail.loadFailed'), 'error');
    }
  }
  async function generateMachineId() {
    try {
      const res = await api('/generate-machine-id');
      const d = await res.json();
      if (d.machineId) $('machineIdInput').value = d.machineId;
    } catch (e) {
      toast(t('detail.generateFailed'), 'error');
    }
  }
  async function putAccount(id, body, successMsg) {
    try {
      const res = await api('/accounts/' + id, { method: 'PUT', body: JSON.stringify(body) });
      const d = await res.json();
      if (d.success) {
        toast(successMsg, 'success');
        loadAccounts();
      } else {
        toast(t('detail.saveFailed') + (d.error ? ': ' + d.error : ''), 'error');
      }
    } catch (e) {
      toast(t('detail.saveFailed'), 'error');
    }
  }
  async function saveMachineId(id) {
    const m = $('machineIdInput').value.trim();
    if (m && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m) && !/^[0-9a-f]{32}$/i.test(m)) {
      toast(t('detail.machineIdError'), 'warning'); return;
    }
    await putAccount(id, { machineId: m }, t('detail.saved'));
  }
  async function saveWeight(id) {
    const weight = parseInt($('weightInput').value, 10) || 0;
    await putAccount(id, { weight }, t('detail.saved'));
  }
  function renderOverageBadge(a) {
    const status = (a.overageStatus || '').toUpperCase();
    if (status === 'ENABLED') {
      return '<span class="badge badge-warning">' + escapeHtml(t('accounts.overageOn')) + '</span>';
    }
    if (status === 'DISABLED') {
      return '<span class="badge badge-muted">' + escapeHtml(t('accounts.overageOff')) + '</span>';
    }
    return '';
  }
  function renderOverageBlock(a, idAttr) {
    const status = (a.overageStatus || '').toUpperCase();
    const capable = !a.overageCapability || a.overageCapability === 'OVERAGE_CAPABLE';
    const checked = status === 'ENABLED';
    const checkedAt = a.overageCheckedAt ? new Date(a.overageCheckedAt * 1000).toLocaleString() : '-';
    const statusText = status === 'ENABLED' ? t('detail.overageEnabled')
      : status === 'DISABLED' ? t('detail.overageDisabled')
      : t('detail.overageUnknown');
    const disabledAttr = capable ? '' : ' disabled';
    return '<div class="form-group flex items-center gap-2">' +
      '<label class="switch"><input type="checkbox" id="overageSwitchInput-' + idAttr + '" data-detail-action="toggleOverage" data-id="' + idAttr + '" ' + (checked ? 'checked' : '') + disabledAttr + ' /><span class="slider"></span></label>' +
      '<span id="overageSwitchLabel-' + idAttr + '">' + escapeHtml(statusText) + '</span>' +
      '</div>' +
      (capable ? '' : '<p class="help-block" style="color:#ef4444">' + escapeHtml(t('detail.overageNotCapable')) + '</p>') +
      '<div class="detail-grid">' +
      detailItem(t('detail.overageStatus'), status || '-') +
      detailItem(t('detail.overageCap'), a.overageCap ? '$' + Number(a.overageCap).toFixed(2) : '-') +
      detailItem(t('detail.overageRate'), a.overageRate ? '$' + Number(a.overageRate).toFixed(4) : '-') +
      detailItem(t('detail.overageCurrent'), a.currentOverages ? '$' + Number(a.currentOverages).toFixed(4) : '$0') +
      detailItem(t('detail.overageCheckedAt'), checkedAt) +
      '</div>';
  }
  async function toggleOverageSwitch(id, inputEl) {
    const desired = inputEl.checked;
    const labelEl = $('overageSwitchLabel-' + id);
    const oldLabel = labelEl ? labelEl.textContent : '';
    inputEl.disabled = true;
    if (labelEl) labelEl.textContent = t('detail.overageSwitching');
    try {
      const res = await api('/accounts/' + encodeURIComponent(id) + '/overage', {
        method: 'POST',
        body: JSON.stringify({ enabled: desired }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.success === false) {
        throw new Error(d.error || t('accounts.overageSwitchFailed'));
      }
      if (labelEl) {
        labelEl.textContent = d.overageStatus === 'ENABLED' ? t('detail.overageEnabled')
          : d.overageStatus === 'DISABLED' ? t('detail.overageDisabled')
          : t('detail.overageUnknown');
      }
      inputEl.checked = d.overageStatus === 'ENABLED';
      await loadAccounts();
    } catch (e) {
      inputEl.checked = !desired;
      if (labelEl) labelEl.textContent = oldLabel;
      toast(t('accounts.overageSwitchFailed') + ': ' + (e.message || e), 'warning');
    } finally {
      inputEl.disabled = false;
    }
  }
  async function refreshAccountOverage(id) {
    try {
      const res = await api('/accounts/' + encodeURIComponent(id) + '/overage', { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.success === false) {
        throw new Error(d.error || t('accounts.overageSwitchFailed'));
      }
      await loadAccounts();
      showDetail(id);
    } catch (e) {
      toast(t('accounts.overageSwitchFailed') + ': ' + (e.message || e), 'warning');
    }
  }
  async function saveProxyURL(id) {
    const url = $('proxyURLInput').value.trim();
    if (url && !/^(socks5|socks5h|http|https):\/\//.test(url)) {
      toast(t('detail.proxyFormatError'), 'warning'); return;
    }
    await putAccount(id, { proxyURL: url }, t('detail.proxySaved'));
  }
  function closeDetailModal() { closeDialog('detailModal'); }

  // Test flow
  function getTestAccount(id) {
    return accountsData.find(a => a.id === id) || null;
  }
  function getTestModelValue() {
    const choice = $('testModelChoice');
    return (choice && choice.value.trim()) || 'claude-sonnet-4';
  }
  function renderTestLog() {
    const c = $('testModalLog');
    if (!c) return;
    if (!testLogs.length) {
      c.innerHTML = '<div class="test-log-empty">' + escapeHtml(t('accounts.testLog.empty')) + '</div>';
      return;
    }
    c.innerHTML = testLogs.map(log =>
      '<div class="test-log-line ' + escapeAttr(log.type || 'info') + '">' +
      '<span class="test-log-time">' + escapeHtml(log.time) + '</span>' +
      '<span class="test-log-message">' + escapeHtml(log.msg) + '</span>' +
      '</div>'
    ).join('');
    c.scrollTop = c.scrollHeight;
  }
  function addTestLog(msg, type) {
    const time = new Date().toLocaleTimeString();
    testLogs.push({ time, msg, type });
    if (testLogs.length > 100) testLogs.shift();
    renderTestLog();
  }
  function clearTestLog() {
    testLogs = [];
    renderTestLog();
  }
  function renderTestModal() {
    const body = $('testBody');
    if (!body) return;
    const acc = getTestAccount(testModalAccountId);
    const idAttr = escapeAttr(testModalAccountId);
    const email = acc ? getDisplayEmail(acc.email, acc.id) : testModalAccountId;
    const proxy = acc ? (acc.proxyURL || t('accounts.testLog.globalProxy')) : '?';
    const statusText = testModalLoadingModels
      ? t('accounts.testModelsLoading')
      : testModalModelError
        ? t('accounts.testModelsFallback')
        : t('accounts.testModelsReady', testModalModels.length);
    const modelField = testModalLoadingModels
      ? '<div class="test-model-loading">' + escapeHtml(t('accounts.testModelsLoading')) + '</div>'
      : testModalModels.length
        ? '<select id="testModelChoice">' +
        testModalModels.map(m => '<option value="' + escapeAttr(m) + '">' + escapeHtml(m) + '</option>').join('') +
        '</select>'
        : '<input type="text" id="testModelChoice" placeholder="claude-sonnet-4" value="claude-sonnet-4" />';

    body.innerHTML =
      '<div class="test-modal-account">' +
      '<div class="test-modal-account-main">' +
      '<div class="test-modal-email">' + escapeHtml(email) + '</div>' +
      '<div class="test-modal-meta">' +
      '<span>' + escapeHtml(formatAuthMethod(acc && (acc.provider || acc.authMethod))) + '</span>' +
      '<span>' + escapeHtml(proxy) + '</span>' +
      '</div>' +
      '</div>' +
      '<span class="test-modal-status">' + escapeHtml(statusText) + '</span>' +
      '</div>' +
      '<div class="test-modal-grid">' +
      '<div class="form-group test-model-field">' +
      '<label for="testModelChoice">' + escapeHtml(t('accounts.selectModel')) + '</label>' +
      modelField +
      '</div>' +
      '<div class="test-log-card">' +
      '<div class="test-log-header">' +
      '<span class="test-log-title">' + escapeHtml(t('accounts.testLog.title')) + '</span>' +
      '<button class="btn btn-xs btn-outline test-log-clear" id="testLogClear" type="button">' + escapeHtml(t('accounts.testLog.clear')) + '</button>' +
      '</div>' +
      '<div class="test-log-content" id="testModalLog"></div>' +
      '</div>' +
      '</div>' +
      '<div class="modal-footer">' +
      '<button class="btn btn-secondary" id="testModalCancelBtn" type="button">' + escapeHtml(t('common.close')) + '</button>' +
      '<button class="btn btn-primary" id="testRunBtn" data-id="' + idAttr + '" type="button" ' + (testModalLoadingModels ? 'disabled' : '') + '>' + escapeHtml(t('accounts.test')) + '</button>' +
      '</div>';

    if (!testModalLoadingModels) enhanceCustomSelects(body);
    renderTestLog();
  }
  async function testAccount(id) {
    testModalAccountId = id;
    testModalModels = [];
    testModalLoadingModels = true;
    testModalModelError = false;
    testModalRunning = false;
    testLogs = [];
    renderTestModal();
    openDialog('testModal');
    try {
      const res = await api('/accounts/' + id + '/models/cached');
      const d = await res.json();
      testModalModels = Array.isArray(d.models) ? d.models.slice().sort() : [];
    } catch (e) {
      testModalModelError = true;
    } finally {
      testModalLoadingModels = false;
      renderTestModal();
    }
  }
  function closeTestModal() {
    closeAllCustomSelects();
    closeDialog('testModal');
  }
  async function runTestAccount(id, model) {
    if (testModalRunning) return;
    testModalRunning = true;
    const modalBtn = $('testRunBtn');
    if (modalBtn) modalBtn.setAttribute('aria-busy', 'true');
    const acc = accountsData.find(a => a.id === id);
    const email = acc ? getDisplayEmail(acc.email, acc.id) : id;
    const proxy = acc ? (acc.proxyURL || t('accounts.testLog.globalProxy')) : '?';
    addTestLog(t('accounts.testLog.start', email, model, proxy), 'info');
    try {
      const startTime = Date.now();
      const res = await api('/accounts/' + id + '/test', { method: 'POST', body: JSON.stringify({ model }) });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const d = await res.json();
      if (d.success) {
        addTestLog(t('accounts.testLog.success', email, elapsed, d.reply), 'ok');
      } else {
        addTestLog(t('accounts.testLog.failed', email, elapsed, d.error || t('common.unknownError')), 'err');
      }
    } catch (e) {
      addTestLog(t('accounts.testLog.error', email, e.message), 'err');
    }
    testModalRunning = false;
    if (modalBtn) modalBtn.removeAttribute('aria-busy');
  }

  // Settings
  async function loadSettings() {
    const res = await api('/settings');
    const d = await res.json();
    $('requireApiKey').checked = d.requireApiKey;
    $('allowOverUsage').checked = d.allowOverUsage || false;
    await Promise.all([loadThinkingConfig(), loadEndpointConfig(), loadProxyConfig(), loadPromptFilter(), loadApiKeys()]);
    refreshCustomSelects();
  }
  async function loadThinkingConfig() {
    const res = await api('/thinking');
    const d = await res.json();
    $('thinkingSuffix').value = d.suffix || '-thinking';
    $('openaiThinkingFormat').value = d.openaiFormat || 'reasoning_content';
    $('claudeThinkingFormat').value = d.claudeFormat || 'thinking';
  }
  async function saveThinkingConfig() {
    const res = await api('/thinking', {
      method: 'POST', body: JSON.stringify({
        suffix: $('thinkingSuffix').value || '-thinking',
        openaiFormat: $('openaiThinkingFormat').value,
        claudeFormat: $('claudeThinkingFormat').value
      })
    });
    const d = await res.json();
    if (d.success) toast(t('settings.thinkingSaved'), 'success');
    else toast(t('common.saveFailed') + ': ' + (d.error || ''), 'error');
  }
  async function loadEndpointConfig() {
    const res = await api('/endpoint');
    const d = await res.json();
    $('preferredEndpoint').value = d.preferredEndpoint || 'auto';
    $('endpointFallback').checked = d.endpointFallback !== false;
  }
  async function saveEndpointConfig() {
    const res = await api('/endpoint', {
      method: 'POST', body: JSON.stringify({
        preferredEndpoint: $('preferredEndpoint').value,
        endpointFallback: $('endpointFallback').checked
      })
    });
    const d = await res.json();
    if (d.success) toast(t('settings.endpointSaved'), 'success');
    else toast(t('common.saveFailed') + ': ' + (d.error || ''), 'error');
  }
  async function loadProxyConfig() {
    const res = await api('/proxy');
    const d = await res.json();
    const url = d.proxyURL || '';
    if (!url) {
      $('proxyType').value = 'none';
      $('proxyFields').classList.add('hidden');
      return;
    }
    try {
      const u = new URL(url);
      const scheme = u.protocol.replace(':', '');
      $('proxyType').value = scheme.startsWith('socks5') ? 'socks5' : 'http';
      $('proxyHost').value = u.hostname;
      $('proxyPort').value = u.port;
      $('proxyUsername').value = decodeURIComponent(u.username);
      $('proxyPassword').value = decodeURIComponent(u.password);
      $('proxyFields').classList.remove('hidden');
    } catch (e) {
      $('proxyType').value = 'none';
      $('proxyFields').classList.add('hidden');
    }
  }
  function onProxyTypeChange() {
    const type = $('proxyType').value;
    $('proxyFields').classList.toggle('hidden', type === 'none');
  }
  async function saveProxyConfig() {
    const type = $('proxyType').value;
    let url = '';
    if (type !== 'none') {
      const host = $('proxyHost').value.trim();
      const port = $('proxyPort').value.trim();
      if (!host || !port) { toast(t('settings.proxyHostRequired'), 'warning'); return; }
      const u = $('proxyUsername').value.trim();
      const p = $('proxyPassword').value.trim();
      const auth = u ? (p ? encodeURIComponent(u) + ':' + encodeURIComponent(p) + '@' : encodeURIComponent(u) + '@') : '';
      url = type + '://' + auth + host + ':' + port;
    }
    const res = await api('/proxy', { method: 'POST', body: JSON.stringify({ proxyURL: url }) });
    const d = await res.json();
    if (d.success) toast(t('settings.proxySaved'), 'success');
    else toast(t('common.saveFailed') + ': ' + (d.error || ''), 'error');
  }
  async function saveRequireApiKey() {
    try {
      const requireApiKey = $('requireApiKey').checked;
      if (requireApiKey) {
        const hasEnabledKey = Array.isArray(apiKeysCache) && apiKeysCache.some(k => k && k.enabled);
        if (!hasEnabledKey) {
          if (!confirm(t('apiKeys.requireWithoutEnabledKeyWarning'))) {
            $('requireApiKey').checked = false;
            return;
          }
        }
      }
      const res = await api('/settings', { method: 'POST', body: JSON.stringify({ requireApiKey }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.success === false) throw new Error(d.error || t('common.saveFailed'));
      toast(t('detail.saved'), 'success');
    } catch (e) {
      toast((e && e.message) || t('common.saveFailed'), 'error');
    }
  }
  async function saveOverUsageConfig() {
    const allowOverUsage = $('allowOverUsage').checked;
    await api('/settings', { method: 'POST', body: JSON.stringify({ allowOverUsage }) });
    toast(t('settings.overUsageSaved'), 'success');
  }
  async function changePassword() {
    const np = $('newPassword').value;
    if (!np) return toast(t('settings.passwordRequired'), 'warning');
    try {
      const res = await api('/settings', { method: 'POST', body: JSON.stringify({ password: np }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.success === false) throw new Error(d.error || t('common.saveFailed'));
      setActivePassword(np, localStorage.getItem('kiro_remember') === '1');
      toast(t('settings.passwordChanged'), 'success');
      $('newPassword').value = '';
    } catch (e) {
      toast((e && e.message) || t('common.saveFailed'), 'error');
    }
  }
  async function resetStats() {
    const ok = await confirmAction(t('settings.confirmReset'), {
      title: t('settings.statistics'),
      confirmText: t('settings.resetStats'),
      variant: 'danger'
    });
    if (!ok) return;
    try {
      const res = await api('/stats/reset', { method: 'POST' });
      if (!res.ok) throw new Error(t('common.failed'));
      loadStats();
      toastPrimary(t('settings.statsReset'));
    } catch (e) {
      toastError((e && e.message) || t('common.failed'));
    }
  }
  // Multi API Key management
  let apiKeysCache = [];
  let apiKeyEditingId = '';
  let apiKeyModalSubmitting = false;

  async function loadApiKeys() {
    try {
      const res = await api('/api-keys');
      if (!res.ok) throw new Error('http ' + res.status);
      const d = await res.json();
      apiKeysCache = Array.isArray(d.apiKeys) ? d.apiKeys : [];
    } catch (e) {
      apiKeysCache = [];
    }
    const list = $('apiKeysList');
    if (list) renderApiKeys();
  }

  function formatNumber(n) {
    if (n == null || isNaN(n)) return '0';
    if (Math.abs(n) >= 1 && Math.floor(n) === n) return Number(n).toLocaleString('en-US');
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
  }

  function usageBar(used, limit) {
    if (!limit || limit <= 0) return '';
    const ratio = Math.max(0, Math.min(1, used / limit));
    const pct = (ratio * 100).toFixed(1);
    let color = '#3b82f6';
    if (ratio >= 0.95) color = '#ef4444';
    else if (ratio >= 0.8) color = '#f59e0b';
    return '<div style="height:6px;background:rgba(127,127,127,0.2);border-radius:3px;overflow:hidden;margin-top:4px;">' +
      '<div style="height:100%;width:' + pct + '%;background:' + color + ';transition:width 0.3s;"></div>' +
      '</div>';
  }

  function usageLine(label, used, limit, options) {
    options = options || {};
    const fmt = options.fmt || formatNumber;
    if (!limit || limit <= 0) {
      return '<div class="text-xs muted-text">' + escapeHtml(label) + ': ' + escapeHtml(fmt(used)) + ' / ' + escapeHtml(t('apiKeys.unlimited')) + '</div>';
    }
    return '<div class="text-xs muted-text">' + escapeHtml(label) + ': ' + escapeHtml(fmt(used)) + ' / ' + escapeHtml(fmt(limit)) + '</div>' + usageBar(used, limit);
  }

  function renderApiKeys() {
    const list = $('apiKeysList');
    if (!list) return;
    if (!apiKeysCache.length) {
      list.innerHTML = '<div class="muted-text" style="padding:0.5rem 0;">' + escapeHtml(t('apiKeys.empty')) + '</div>';
      return;
    }
    const html = apiKeysCache.map(item => {
      const id = escapeAttr(item.id || '');
      const name = item.name ? escapeHtml(item.name) : '<span class="muted-text">' + escapeHtml(t('apiKeys.unnamed')) + '</span>';
      const masked = escapeHtml(item.keyMasked || '');
      const migrated = item.migrated
        ? '<span class="text-xs" style="background:rgba(59,130,246,0.15);color:#3b82f6;padding:1px 6px;border-radius:4px;">' + escapeHtml(t('apiKeys.migrated')) + '</span>'
        : '';
      const disabled = !item.enabled
        ? '<span class="text-xs" style="background:rgba(239,68,68,0.15);color:#ef4444;padding:1px 6px;border-radius:4px;">' + escapeHtml(t('apiKeys.disabled')) + '</span>'
        : '';
      const tokensLine = usageLine(t('apiKeys.tokens'), item.tokensUsed || 0, item.tokenLimit || 0);
      const creditsLine = usageLine(t('apiKeys.credits'), item.creditsUsed || 0, item.creditLimit || 0);
      const requestsLine = '<div class="text-xs muted-text">' + escapeHtml(t('apiKeys.requests')) + ': ' + escapeHtml(formatNumber(item.requestsCount || 0)) + '</div>';
      return '<div class="card" data-apikey-id="' + id + '" style="margin-top:0.5rem;padding:0.75rem;">' +
        '<div class="flex items-center gap-2" style="flex-wrap:wrap;justify-content:space-between;">' +
          '<div class="flex items-center gap-2" style="flex-wrap:wrap;">' +
            '<span class="font-semibold">' + name + '</span>' +
            migrated +
            disabled +
            '<span class="text-xs muted-text font-mono">' + masked + '</span>' +
          '</div>' +
          '<div class="flex items-center gap-2">' +
            '<label class="switch" title="' + escapeAttr(item.enabled ? t('accounts.disable') : t('accounts.enable')) + '">' +
              '<input type="checkbox" data-apikey-action="toggle" data-id="' + id + '"' + (item.enabled ? ' checked' : '') + ' />' +
              '<span class="slider"></span>' +
            '</label>' +
            '<button class="btn btn-outline btn-sm" type="button" data-apikey-action="edit" data-id="' + id + '">' + escapeHtml(t('apiKeys.actionEdit')) + '</button>' +
            '<button class="btn btn-outline btn-sm" type="button" data-apikey-action="reset" data-id="' + id + '">' + escapeHtml(t('apiKeys.actionReset')) + '</button>' +
            '<button class="btn btn-danger btn-sm" type="button" data-apikey-action="delete" data-id="' + id + '">' + escapeHtml(t('apiKeys.actionDelete')) + '</button>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:0.5rem;display:grid;gap:0.35rem;">' +
          tokensLine +
          creditsLine +
          requestsLine +
        '</div>' +
      '</div>';
    }).join('');
    list.innerHTML = html;
  }

  function openApiKeyModal(entry) {
    apiKeyEditingId = entry ? (entry.id || '') : '';
    const titleEl = $('apiKeyModalTitle');
    titleEl.textContent = t(apiKeyEditingId ? 'apiKeys.modalTitleEdit' : 'apiKeys.modalTitleCreate');
    $('apiKeyForm_name').value = entry ? (entry.name || '') : '';
    const keyEl = $('apiKeyForm_key');
    if (apiKeyEditingId) {
      keyEl.value = entry.keyMasked || '';
      keyEl.readOnly = true;
    } else {
      keyEl.value = '';
      keyEl.readOnly = false;
    }
    $('apiKeyForm_enabled').checked = entry ? !!entry.enabled : true;
    $('apiKeyForm_tokenLimit').value = entry ? String(entry.tokenLimit || 0) : '0';
    $('apiKeyForm_creditLimit').value = entry ? String(entry.creditLimit || 0) : '0';
    apiKeyModalSubmitting = false;
    $('apiKeyModalSaveBtn').disabled = false;
    openDialog('apiKeyModal');
  }

  function closeApiKeyModal() {
    closeDialog('apiKeyModal');
    apiKeyEditingId = '';
    apiKeyModalSubmitting = false;
    $('apiKeyModalSaveBtn').disabled = false;
  }

  async function submitApiKeyModal() {
    if (apiKeyModalSubmitting) return;
    apiKeyModalSubmitting = true;
    const saveBtn = $('apiKeyModalSaveBtn');
    saveBtn.disabled = true;
    try {
      const name = $('apiKeyForm_name').value.trim();
      const enabled = $('apiKeyForm_enabled').checked;
      const tokenLimit = parseInt($('apiKeyForm_tokenLimit').value, 10);
      const creditLimit = parseFloat($('apiKeyForm_creditLimit').value);
      const payload = {
        name: name,
        enabled: enabled,
        tokenLimit: isNaN(tokenLimit) || tokenLimit < 0 ? 0 : tokenLimit,
        creditLimit: isNaN(creditLimit) || creditLimit < 0 ? 0 : creditLimit
      };
      let res, d;
      if (apiKeyEditingId) {
        res = await api('/api-keys/' + encodeURIComponent(apiKeyEditingId), { method: 'PUT', body: JSON.stringify(payload) });
        d = await res.json().catch(() => ({}));
        if (!res.ok || d.success === false) throw new Error(d.error || t('common.saveFailed'));
        toast(t('apiKeys.updated'), 'success');
        closeApiKeyModal();
        await loadApiKeys();
      } else {
        const keyVal = $('apiKeyForm_key').value.trim();
        if (keyVal) payload.key = keyVal;
        res = await api('/api-keys', { method: 'POST', body: JSON.stringify(payload) });
        d = await res.json().catch(() => ({}));
        if (!res.ok || d.success === false) throw new Error(d.error || t('common.saveFailed'));
        toast(t('apiKeys.created'), 'success');
        closeApiKeyModal();
        await loadApiKeys();
        if (d.key) showNewApiKey(d.key);
      }
    } catch (e) {
      toast((e && e.message) || t('common.saveFailed'), 'error');
      apiKeyModalSubmitting = false;
      saveBtn.disabled = false;
    }
  }

  async function toggleApiKeyEntry(id, enabled) {
    try {
      const res = await api('/api-keys/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ enabled }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.success === false) throw new Error(d.error || t('common.saveFailed'));
      const item = apiKeysCache.find(x => x.id === id);
      if (item) item.enabled = enabled;
      renderApiKeys();
    } catch (e) {
      toast((e && e.message) || t('common.saveFailed'), 'error');
      await loadApiKeys();
    }
  }

  async function deleteApiKeyEntry(id, name) {
    const ok = await confirmAction(t('apiKeys.confirmDelete', name || t('apiKeys.unnamed')), {
      title: t('apiKeys.actionDelete'),
      confirmText: t('apiKeys.actionDelete'),
      variant: 'danger'
    });
    if (!ok) return;
    try {
      const res = await api('/api-keys/' + encodeURIComponent(id), { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.success === false) throw new Error(d.error || t('common.failed'));
      toast(t('apiKeys.deleteSuccess'), 'success');
      await loadApiKeys();
    } catch (e) {
      toast((e && e.message) || t('common.failed'), 'error');
    }
  }

  async function resetApiKeyUsageEntry(id, name) {
    const ok = await confirmAction(t('apiKeys.confirmReset', name || t('apiKeys.unnamed')), {
      title: t('apiKeys.actionReset'),
      confirmText: t('apiKeys.actionReset')
    });
    if (!ok) return;
    try {
      const res = await api('/api-keys/' + encodeURIComponent(id) + '/reset-usage', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.success === false) throw new Error(d.error || t('common.failed'));
      toast(t('apiKeys.usageReset'), 'success');
      await loadApiKeys();
    } catch (e) {
      toast((e && e.message) || t('common.failed'), 'error');
    }
  }

  function showNewApiKey(plaintext) {
    $('apiKeyShowValue').value = plaintext || '';
    openDialog('apiKeyShowModal');
    setTimeout(() => {
      const el = $('apiKeyShowValue');
      if (el) { try { el.select(); } catch (_) { } }
    }, 0);
  }

  function closeShowApiKeyModal() {
    closeDialog('apiKeyShowModal');
    $('apiKeyShowValue').value = '';
  }

  async function copyNewApiKey() {
    const val = $('apiKeyShowValue').value;
    if (!val) return;
    try {
      await copyText(val);
      toast(t('apiKeys.copySuccess'), 'success');
    } catch (e) {
      toast(t('common.failed'), 'error');
    }
  }

  function bindApiKeyEvents() {
    const list = $('apiKeysList');
    if (list) {
      list.addEventListener('click', e => {
        const btn = e.target.closest('[data-apikey-action]');
        if (!btn) return;
        const action = btn.dataset.apikeyAction;
        const id = btn.dataset.id;
        if (!id) return;
        const entry = apiKeysCache.find(x => x.id === id);
        const name = entry ? entry.name : '';
        if (action === 'edit') openApiKeyModal(entry);
        else if (action === 'delete') deleteApiKeyEntry(id, name);
        else if (action === 'reset') resetApiKeyUsageEntry(id, name);
      });
      list.addEventListener('change', e => {
        const cb = e.target.closest('input[data-apikey-action="toggle"]');
        if (!cb) return;
        const id = cb.dataset.id;
        if (!id) return;
        toggleApiKeyEntry(id, cb.checked);
      });
    }
    const addBtn = $('addApiKeyBtn');
    if (addBtn) addBtn.addEventListener('click', () => openApiKeyModal(null));
    const saveBtn = $('apiKeyModalSaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', submitApiKeyModal);
    const cancelBtn = $('apiKeyModalCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeApiKeyModal);
    const closeBtn = $('apiKeyModalClose');
    if (closeBtn) closeBtn.addEventListener('click', closeApiKeyModal);
    const showCloseBtn = $('apiKeyShowCloseBtn');
    if (showCloseBtn) showCloseBtn.addEventListener('click', closeShowApiKeyModal);
    const showCloseX = $('apiKeyShowClose');
    if (showCloseX) showCloseX.addEventListener('click', closeShowApiKeyModal);
    const copyBtn = $('apiKeyShowCopyBtn');
    if (copyBtn) copyBtn.addEventListener('click', copyNewApiKey);
    bindDialogBackdropClose('apiKeyModal', closeApiKeyModal);
    bindDialogBackdropClose('apiKeyShowModal', closeShowApiKeyModal);
  }


  // =====================================================================
  // COMBOS TAB
  // =====================================================================

  let combosData = [];

  async function loadCombos() {
    const list = $('combosList');
    if (!list) return;
    try {
      const res = await api('/combos');
      const d = await res.json();
      combosData = Array.isArray(d.combos) ? d.combos : [];
      renderCombos();
    } catch (e) {
      combosData = [];
      list.innerHTML = '<div class="muted-text" style="padding:0.5rem 0;">' + escapeHtml(t('combos.loadFailed')) + '</div>';
    }
  }

  function renderCombos() {
    const list = $('combosList');
    if (!list) return;
    if (!combosData.length) {
      list.innerHTML = '<div class="muted-text" style="padding:0.5rem 0;">' + escapeHtml(t('combos.empty')) + '</div>';
      return;
    }
    list.innerHTML = combosData.map(combo => {
      const chain = Array.isArray(combo.models) ? combo.models.join(' → ') : '';
      const strategy = combo.strategy || 'fallback';
      return '<div class="api-key-entry" style="margin-bottom:0.5rem;padding:0.75rem;border:1px solid var(--border);border-radius:6px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.5rem;">' +
        '<div>' +
        '<span style="font-weight:600;font-size:1rem;">' + escapeHtml(combo.name) + '</span>' +
        '<span style="margin-left:0.5rem;padding:0.1rem 0.4rem;border-radius:4px;font-size:0.75rem;background:var(--badge-bg,#e8f4fd);color:var(--badge-color,#1a73e8);">' + escapeHtml(strategy) + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:0.4rem;">' +
        '<button class="btn btn-small" onclick="editCombo(\'' + escapeHtml(combo.id).replace(/'/g, '&#39;') + '\')" data-i18n="combos.actionEdit"></button>' +
        '<button class="btn btn-small btn-danger" onclick="deleteCombo(\'' + escapeHtml(combo.id).replace(/'/g, '&#39;') + '\',\'' + escapeHtml(combo.name).replace(/'/g, '&#39;') + '\')" data-i18n="combos.delete"></button>' +
        '</div>' +
        '</div>' +
        '<div style="margin-top:0.4rem;font-size:0.85rem;color:var(--muted-foreground,#888);word-break:break-all;">' + escapeHtml(chain) + '</div>' +
        '</div>';
    }).join('');
    applyTranslations();
  }

  let comboEditId = null;
  let comboModelRows = [];
  let comboDragIndex = null;

  function openComboModal(combo) {
    comboEditId = combo ? combo.id : null;
    $('comboModalTitle').setAttribute('data-i18n', combo ? 'combos.modalTitleEdit' : 'combos.modalTitleCreate');
    $('comboForm_name').value = combo ? combo.name : '';
    $('comboForm_strategy').value = combo ? (combo.strategy || 'fallback') : 'fallback';
    comboModelRows = combo && Array.isArray(combo.models) ? [...combo.models] : [];
    renderComboModelRows();
    applyTranslations();
    openDialog('comboModal');
  }

  function renderComboModelRows() {
    const container = $('comboModelsContainer');
    if (!container) return;
    container.innerHTML =
      '<div class="combo-model-list">' +
      comboModelRows.map((m, i) =>
        '<div draggable="true" data-index="' + i + '" ' +
        'ondragstart="onComboRowDragStart(event)" ' +
        'ondragover="onComboRowDragOver(event)" ' +
        'ondrop="onComboRowDrop(event)" ' +
        'class="combo-model-row">' +
        '<span class="combo-model-grip">&#9776;</span>' +
        '<span class="combo-model-name">' + escapeHtml(m) + '</span>' +
        '<button type="button" class="combo-model-remove" onclick="removeComboModelRow(' + i + ')" title="' + escapeHtml(t('common.remove')) + '">&times;</button>' +
        '</div>'
      ).join('') +
      '</div>' +
      '<button type="button" class="btn btn-small" onclick="openModelPicker()" style="margin-top:0.4rem;">' + escapeHtml(t('combos.addModel')) + '</button>';
  }

  function removeComboModelRow(idx) {
    comboModelRows.splice(idx, 1);
    renderComboModelRows();
  }

  function onComboRowDragStart(e) {
    const el = e.target.closest('[draggable]');
    if (!el) return;
    comboDragIndex = parseInt(el.dataset.index, 10);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    el.classList.add('combo-model-dragging');
  }

  function onComboRowDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('[draggable]');
    if (target) target.classList.add('combo-model-dragover');
  }

  function onComboRowDrop(e) {
    e.preventDefault();
    document.querySelectorAll('.combo-model-dragover, .combo-model-dragging').forEach(el => {
      el.classList.remove('combo-model-dragover', 'combo-model-dragging');
    });
    const target = e.target.closest('[draggable]');
    if (!target) return;
    let targetIndex = parseInt(target.dataset.index, 10);
    if (comboDragIndex === null || comboDragIndex === targetIndex) return;
    const item = comboModelRows.splice(comboDragIndex, 1)[0];
    if (targetIndex > comboDragIndex) targetIndex--;
    comboModelRows.splice(targetIndex, 0, item);
    comboDragIndex = null;
    renderComboModelRows();
  }

  // ── Model Picker (multi-select) ─────────────────────────────────
  const PROVIDER_ALIAS_NAMES = {
    cc: 'Claude Code', ag: 'Antigravity', cx: 'OpenAI Codex',
    if: 'iFlow AI', qw: 'Qwen Code', gc: 'Gemini CLI',
    gh: 'GitHub Copilot', kr: 'Kiro AI',
    openrouter: 'OpenRouter', glm: 'GLM Coding', kimi: 'Kimi Coding',
    minimax: 'Minimax Coding', openai: 'OpenAI', anthropic: 'Anthropic',
    gemini: 'Gemini'
  };
  const PROVIDER_ALIAS_ORDER = [
    'cc','ag','cx','if','qw','gc','gh','kr',
    'openrouter','glm','kimi','minimax','openai','anthropic','gemini'
  ];

  let pickerModels = [];
  let pickerCombos = [];
  let pickerSelection = new Set();

  window.modelTestResults = {};
  window.modelTesting = {};

  async function openModelPicker() {
    try {
      const res = await fetch('/v1/models');
      const data = await res.json();
      const models = data.data || [];
      pickerCombos = [];
      pickerModels = [];
      models.forEach(m => {
        if (m.owned_by === 'combo') {
          pickerCombos.push(m.id);
        } else {
          pickerModels.push({ id: m.id, provider: m.owned_by });
        }
      });
      pickerSelection = new Set(comboModelRows);
      $('modelPickerSearch').value = '';
      renderModelPicker('');
      openDialog('modelPickerModal');
    } catch (e) {
      toast(t('combos.loadModelsFailed'), 'error');
    }
  }

  window.testModel = async function (modelId) {
    if (window.modelTesting[modelId]) return;
    window.modelTesting[modelId] = true;
    renderModelPicker($('modelPickerSearch').value);
    try {
      const res = await api('/cli-tools/test-model', {
        method: 'POST',
        body: JSON.stringify({ model: modelId })
      });
      const data = await res.json();
      window.modelTestResults[modelId] = data.ok ? 'ok' : 'error';
    } catch (e) {
      window.modelTestResults[modelId] = 'error';
    }
    delete window.modelTesting[modelId];
    renderModelPicker($('modelPickerSearch').value);
  };

  function renderModelPicker(query) {
    const list = $('modelPickerList');
    if (!list) return;
    const q = (query || '').toLowerCase();
    let html = '';

    const filteredCombos = pickerCombos.filter(c => c.toLowerCase().includes(q));
    if (filteredCombos.length > 0) {
      html += '<div class="picker-group-header" style="color:var(--accent-color);">' + escapeHtml(t('combos.comboGroup')) + '</div>';
      filteredCombos.forEach(c => { html += renderModelItem(c); });
    }

    const sortedProviders = Object.keys(
      pickerModels.reduce((acc, m) => { acc[m.provider] = true; return acc; }, {})
    ).sort((a, b) => {
      const ia = PROVIDER_ALIAS_ORDER.indexOf(a);
      const ib = PROVIDER_ALIAS_ORDER.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

    sortedProviders.forEach(provider => {
      const filtered = pickerModels.filter(m => m.provider === provider && m.id.toLowerCase().includes(q));
      if (filtered.length === 0) return;
      const displayName = PROVIDER_ALIAS_NAMES[provider] || provider;
      html += '<div class="picker-group-header" style="color:var(--text-secondary);">' + escapeHtml(displayName) + '</div>';
      filtered.forEach(m => { html += renderModelItem(m.id); });
    });

    if (!html) {
      html = '<div class="picker-empty">' + escapeHtml(t(q ? 'combos.noMatches' : 'combos.noModels')) + '</div>';
    }
    list.innerHTML = html;
  }

function renderModelItem(modelId) {
  const selected = pickerSelection.has(modelId);
  const testRes = window.modelTestResults ? window.modelTestResults[modelId] : undefined;
  const testing = window.modelTesting ? window.modelTesting[modelId] : false;
  var statusIcon = '';
  if (testing) {
    statusIcon = '<i class="fa-solid fa-spinner fa-spin" style="color:var(--text-secondary);font-size:0.7rem;"></i>';
  } else if (testRes === 'ok') {
    statusIcon = '<i class="fa-solid fa-check-circle" style="color:#22c55e;font-size:0.7rem;"></i>';
  } else if (testRes === 'error') {
    statusIcon = '<i class="fa-solid fa-times-circle" style="color:#ef4444;font-size:0.7rem;"></i>';
  } else {
    statusIcon = '<i class="fa-solid fa-robot" style="color:var(--text-secondary);font-size:0.7rem;"></i>';
  }
  return '<div class="model-picker-item' + (selected ? ' selected' : '') + '" onclick="toggleModelInPicker(\'' + escapeHtml(modelId).replace(/'/g, '&#39;') + '\')">' +
    '<span class="picker-check">' + (selected ? '&#10003;' : '') + '</span>' +
    '<span class="picker-status-icon" style="width:1.1em;text-align:center;flex-shrink:0;">' + statusIcon + '</span>' +
    '<span style="flex:1;">' + escapeHtml(modelId) + '</span>' +
    '<button class="picker-test-btn" onclick="event.stopPropagation();window.testModel(\'' + escapeHtml(modelId).replace(/'/g, '&#39;') + '\')" type="button" title="' + escapeHtml(t('cliTools.testModel')) + '"><i class="fa-solid fa-flask"></i></button>' +
    '</div>';
}

  window.toggleModelInPicker = function (modelId) {
    if (typeof window.__cliModelCallback === 'function') {
      window.__cliModelCallback(modelId);
      window.__cliModelCallback = null;
      return;
    }
    if (pickerSelection.has(modelId)) {
      pickerSelection.delete(modelId);
    } else {
      pickerSelection.add(modelId);
    }
    renderModelPicker($('modelPickerSearch').value);
  }

  function confirmModelPicker() {
    if (typeof window.__cliModelCallback === 'function') {
      window.__cliModelCallback = null;
      closeDialog('modelPickerModal');
      return;
    }
    if (cliToolDetailId === 'opencode') {
      var models = Array.from(pickerSelection);
      if (models.length > 0) {
        var s = window.__openCodeState;
        models.forEach(function (m) {
          if (s.models.indexOf(m) === -1) s.models.push(m);
        });
        if (!s.activeModel) s.activeModel = models[0];
        reRenderDetailBody();
      }
      closeDialog('modelPickerModal');
      return;
    }
    comboModelRows = Array.from(pickerSelection);
    renderComboModelRows();
    closeDialog('modelPickerModal');
  }

  function filterModelPicker() {
    renderModelPicker($('modelPickerSearch').value);
  }

  async function saveCombo() {
    const name = ($('comboForm_name').value || '').trim();
    const strategy = $('comboForm_strategy').value;
    if (!name) { toast(t('combos.nameRequired'), 'error'); return; }
    if (name.includes('/')) { toast(t('combos.nameSlash'), 'error'); return; }
    const models = comboModelRows.map(m => m.trim()).filter(Boolean);
    if (models.length < 1) { toast(t('combos.minModels'), 'error'); return; }
    try {
      let res;
      if (comboEditId) {
        res = await api('/combos/' + encodeURIComponent(comboEditId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, models, strategy })
        });
      } else {
        res = await api('/combos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, models, strategy })
        });
      }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || t('common.failed'));
      toast(comboEditId ? t('combos.updated') : t('combos.created'), 'success');
      closeDialog('comboModal');
      await loadCombos();
    } catch (e) {
      toast((e && e.message) || t('common.failed'), 'error');
    }
  }

  function editCombo(id) {
    const combo = combosData.find(c => c.id === id);
    if (!combo) return;
    openComboModal(combo);
  }

  async function deleteCombo(id, name) {
    const ok = await confirmAction(t('combos.confirmDelete', name), { title: t('combos.delete'), confirmText: t('combos.delete') });
    if (!ok) return;
    try {
      const res = await api('/combos/' + encodeURIComponent(id), { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || t('common.failed'));
      toast(t('combos.deleted'), 'success');
      await loadCombos();
    } catch (e) {
      toast((e && e.message) || t('common.failed'), 'error');
    }
  }

  // Expose combo functions to global scope for inline onclick
  window.editCombo = editCombo;
  window.deleteCombo = deleteCombo;
  window.removeComboModelRow = removeComboModelRow;
  window.openModelPicker = openModelPicker;
  window.filterModelPicker = filterModelPicker;
  window.confirmModelPicker = confirmModelPicker;
  window.onComboRowDragStart = onComboRowDragStart;
  window.onComboRowDragOver = onComboRowDragOver;
  window.onComboRowDrop = onComboRowDrop;

  function bindComboEvents() {
    const createBtn = $('createComboBtn');
    if (createBtn) createBtn.addEventListener('click', () => openComboModal(null));
    const saveBtn = $('comboModalSaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveCombo);
    const cancelBtn = $('comboModalCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => closeDialog('comboModal'));
    const closeBtn = $('comboModalClose');
    if (closeBtn) closeBtn.addEventListener('click', () => closeDialog('comboModal'));
    bindDialogBackdropClose('comboModal', () => closeDialog('comboModal'));
    const pickerCancel = $('modelPickerCancelBtn');
    if (pickerCancel) pickerCancel.addEventListener('click', () => closeDialog('modelPickerModal'));
    const pickerDone = $('modelPickerDoneBtn');
    if (pickerDone) pickerDone.addEventListener('click', confirmModelPicker);
    const pickerClose = $('modelPickerClose');
    if (pickerClose) pickerClose.addEventListener('click', () => closeDialog('modelPickerModal'));
    bindDialogBackdropClose('modelPickerModal', () => closeDialog('modelPickerModal'));
  }

  // Prompt filter rules
  async function loadPromptFilter() {
    const res = await api('/prompt-filter');
    const d = await res.json();
    $('filterClaudeCode').checked = !!d.filterClaudeCode;
    $('filterEnvNoise').checked = !!d.filterEnvNoise;
    $('filterStripBoundaries').checked = !!d.filterStripBoundaries;
    promptRules = d.rules || [];
    renderPromptRules();
  }
  async function savePromptFilter() {
    const res = await api('/prompt-filter', {
      method: 'POST', body: JSON.stringify({
        filterClaudeCode: $('filterClaudeCode').checked,
        filterEnvNoise: $('filterEnvNoise').checked,
        filterStripBoundaries: $('filterStripBoundaries').checked,
        rules: promptRules
      })
    });
    const d = await res.json();
    if (d.success) toast(t('settings.promptFilterSaved'), 'success');
    else toast(t('common.saveFailed') + ': ' + (d.error || ''), 'error');
  }
  function renderPromptRules() {
    const c = $('promptFilterRules');
    if (!c) return;
    if (!promptRules.length) {
      c.innerHTML = '<small class="text-xs muted-text">' + escapeHtml(t('promptFilter.noRules')) + '</small>';
      return;
    }
    c.innerHTML = promptRules.map((r, i) => {
      const isContains = r.type === 'lines-containing';
      const typeLabel = isContains ? t('promptFilter.typeContains') : t('promptFilter.typeRegex');
      const matchPh = isContains ? t('promptFilter.matchPlaceholderContains') : t('promptFilter.matchPlaceholderRegex');
      const replaceRow = !isContains
        ? '<div class="rule-field"><label>' + escapeHtml(t('promptFilter.replace')) + '</label>' +
        '<input value="' + escapeAttr(r.replace || '') + '" data-rule-idx="' + i + '" data-rule-field="replace" placeholder="' + escapeAttr(t('promptFilter.emptyRemove')) + '" />' +
        '</div>'
        : '';
      return '<div class="rule-card' + (r.enabled ? '' : ' disabled') + '">' +
        '<div class="rule-header">' +
        '<label class="switch"><input type="checkbox" ' + (r.enabled ? 'checked' : '') + ' data-rule-toggle="' + i + '" /><span class="slider"></span></label>' +
        '<div class="rule-meta">' +
        '<input class="rule-name-input" value="' + escapeAttr(r.name || '') + '" data-rule-idx="' + i + '" data-rule-field="name" placeholder="' + escapeAttr(t('promptFilter.unnamed')) + '" />' +
        '<span class="rule-type">' + escapeHtml(typeLabel) + '</span>' +
        '</div>' +
        '<button class="rule-remove" data-rule-remove="' + i + '" type="button" aria-label="' + escapeAttr(t('common.remove')) + '">&times;</button>' +
        '</div>' +
        '<div class="rule-body">' +
        '<div class="rule-field"><label>' + escapeHtml(t('promptFilter.match')) + '</label>' +
        '<input value="' + escapeAttr(r.match || '') + '" data-rule-idx="' + i + '" data-rule-field="match" placeholder="' + escapeAttr(matchPh) + '" />' +
        '</div>' +
        replaceRow +
        '</div>' +
        '</div>';
    }).join('');
  }
  function addPromptRule(type) {
    promptRules.push({ id: 'rule-' + Date.now(), name: '', type, match: '', replace: '', enabled: true });
    renderPromptRules();
  }

  // Add-account modal templates
  var METHOD_ICONS = {
    builderid: 'fa-solid fa-id-card',
    iam: 'fa-solid fa-key',
    sso: 'fa-solid fa-shield-halved',
    local: 'fa-solid fa-folder-open',
    credentials: 'fa-solid fa-code',
    cookie: 'fa-solid fa-cookie-bite'
  };
  function methodCard(type, title, desc) {
    var icon = METHOD_ICONS[type] || 'fa-solid fa-circle-plus';
    return '<button type="button" class="method-card" data-method="' + escapeAttr(type) + '">' +
      '<span class="method-icon"><i class="' + icon + '" aria-hidden="true"></i></span>' +
      '<span class="method-body">' +
      '<span class="method-title">' + escapeHtml(title) + '</span>' +
      '<span class="method-desc">' + escapeHtml(desc) + '</span>' +
      '</span>' +
      '<span class="method-arrow" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span>' +
      '</button>';
  }
  function showModal(type) {
    const modal = $('addModal');
    const title = $('modalTitle');
    const body = $('modalBody');
    if (type === 'add') modalAdd(title, body);
    else if (type === 'builderid') modalBuilderId(title, body);
    else if (type === 'iam') modalIam(title, body);
    else if (type === 'sso') modalSso(title, body);
    else if (type === 'local') modalLocal(title, body);
    else if (type === 'credentials') modalCredentials(title, body);
    else if (type === 'cookie') modalCookie(title, body);
    if (!modal.classList.contains('active')) openDialog('addModal');
    enhanceCustomSelects(body);
  }
  function closeModal() {
    closeDialog('addModal');
    iamSession = '';
    if (builderIdPollTimer) { clearTimeout(builderIdPollTimer); builderIdPollTimer = null; }
    builderIdSession = '';
  }
  function modalAdd(title, body) {
    title.textContent = t('modal.addAccount');
    body.innerHTML =
      '<div class="method-list">' +
      methodCard('builderid', t('modal.builderIdTitle'), t('modal.builderIdDesc')) +
      methodCard('iam', t('modal.iamTitle'), t('modal.iamDesc')) +
      methodCard('sso', t('modal.ssoTitle'), t('modal.ssoDesc')) +
      methodCard('local', t('modal.localTitle'), t('modal.localDesc')) +
      methodCard('credentials', t('modal.credentialsTitle'), t('modal.credentialsDesc')) +
      methodCard('cookie', t('modal.cookieTitle'), t('modal.cookieDesc')) +
      '</div>' +
      '<div class="modal-footer"><button class="btn btn-secondary" data-close-add="1" type="button">' + escapeHtml(t('common.cancel')) + '</button></div>';
  }
  function modalBuilderId(title, body) {
    title.textContent = t('modal.builderIdTitle');
    body.innerHTML =
      '<p class="help-block">' + escapeHtml(t('modal.builderIdDesc')) + '</p>' +
      '<div id="builderIdStep1">' +
      '<div class="form-group"><label>' + escapeHtml(t('detail.region')) + '</label><input type="text" id="builderIdRegion" value="us-east-1" /></div>' +
      '<div class="modal-footer">' +
      '<button class="btn btn-secondary" data-modal-goto="add" type="button">' + escapeHtml(t('common.back')) + '</button>' +
      '<button class="btn btn-primary" id="startBuilderIdBtn" type="button">' + escapeHtml(t('builderid.startLogin')) + '</button>' +
      '</div>' +
      '</div>' +
      '<div id="builderIdStep2" class="hidden">' +
      '<div class="message message-info message-center"><p class="builder-code" id="builderIdUserCode"></p><p class="text-xs mt-2">' + escapeHtml(t('builderid.verifyCode')) + '</p></div>' +
      '<div class="form-group mt-4"><label>' + escapeHtml(t('builderid.verifyUrl')) + '</label>' +
      '<div class="endpoint"><span id="builderIdVerifyUrl" class="font-mono text-xs"></span></div>' +
      '<div class="flex gap-2 mt-2">' +
      '<button class="btn btn-sm btn-outline flex-1" id="builderIdOpenBtn" type="button">' + escapeHtml(t('builderid.open')) + '</button>' +
      '<button class="btn btn-sm btn-outline flex-1" id="builderIdCopyBtn" type="button">' + escapeHtml(t('common.copy')) + '</button>' +
      '</div>' +
      '</div>' +
      '<p id="builderIdStatus" class="text-center text-sm mt-4 muted-text">' + escapeHtml(t('builderid.waiting')) + '</p>' +
      '<div class="modal-footer"><button class="btn btn-secondary" id="builderIdCancelBtn" type="button">' + escapeHtml(t('common.cancel')) + '</button></div>' +
      '</div>';
    $('startBuilderIdBtn').addEventListener('click', startBuilderIdLogin);
  }
  function modalIam(title, body) {
    title.textContent = t('modal.iamTitle');
    body.innerHTML =
      '<p class="help-block">' + escapeHtml(t('modal.iamDesc')) + '</p>' +
      '<div class="form-group"><label>' + escapeHtml(t('iam.startUrl')) + '</label><input type="text" id="iamStartUrl" placeholder="https://xxx.awsapps.com/start" /></div>' +
      '<div class="form-group"><label>' + escapeHtml(t('detail.region')) + '</label><input type="text" id="iamRegion" value="us-east-1" /></div>' +
      '<div id="iamStep2" class="hidden">' +
      '<div class="form-group"><label>' + escapeHtml(t('iam.loginUrl')) + '</label>' +
      '<div class="endpoint"><span id="iamAuthUrl" class="font-mono text-xs"></span></div>' +
      '<div class="flex gap-2 mt-2">' +
      '<button class="btn btn-sm btn-outline flex-1" id="iamOpenBtn" type="button">' + escapeHtml(t('builderid.open')) + '</button>' +
      '<button class="btn btn-sm btn-outline flex-1" id="iamCopyBtn" type="button">' + escapeHtml(t('common.copy')) + '</button>' +
      '</div>' +
      '</div>' +
      '<p class="text-sm mt-3 success-text">' + escapeHtml(t('iam.completeLogin')) + '</p>' +
      '<div class="form-group"><label>' + escapeHtml(t('iam.callbackUrl')) + '</label><input type="text" id="iamCallback" placeholder="http://127.0.0.1:xxx/?code=..." /></div>' +
      '</div>' +
      '<div class="modal-footer">' +
      '<button class="btn btn-secondary" data-modal-goto="add" type="button">' + escapeHtml(t('common.back')) + '</button>' +
      '<button class="btn btn-primary" id="iamBtn" type="button">' + escapeHtml(t('builderid.startLogin')) + '</button>' +
      '</div>';
    $('iamBtn').addEventListener('click', startIamSso);
  }
  function modalSso(title, body) {
    title.textContent = t('modal.ssoTitle');
    body.innerHTML =
      '<div class="help-block">' +
      '<b>' + escapeHtml(t('sso.howToGet')) + '</b>' +
      '<ol class="steps-list">' +
      '<li>' + escapeHtml(t('sso.step1')) + ' <code class="code-inline">view.awsapps.com/start</code></li>' +
      '<li>' + escapeHtml(t('sso.step2')) + '</li>' +
      '<li>' + escapeHtml(t('sso.step3')) + ' <code class="code-inline">x-amz-sso_authn</code></li>' +
      '</ol>' +
      '</div>' +
      '<div class="form-group"><label>' + escapeHtml(t('sso.tokenLabel')) + ' <small>' + escapeHtml(t('sso.tokenHint')) + '</small></label>' +
      '<textarea id="ssoToken" placeholder="' + escapeAttr(t('sso.tokenPlaceholder')) + '"></textarea></div>' +
      '<div class="form-group"><label>' + escapeHtml(t('detail.region')) + '</label><input type="text" id="ssoRegion" value="us-east-1" /></div>' +
      '<div class="modal-footer">' +
      '<button class="btn btn-secondary" data-modal-goto="add" type="button">' + escapeHtml(t('common.back')) + '</button>' +
      '<button class="btn btn-primary" id="importSsoBtn" type="button">' + escapeHtml(t('common.add')) + '</button>' +
      '</div>';
    $('importSsoBtn').addEventListener('click', importSsoToken);
  }

  function modalLocal(title, body) {
    title.textContent = t('modal.localTitle');
    body.innerHTML =
      '<p class="help-block">' + escapeHtml(t('modal.localDesc')) + '</p>' +
      '<div class="help-block">' +
      '<p><b>' + escapeHtml(t('local.fileLocation')) + '</b></p>' +
      '<p>' + escapeHtml(t('local.windows')) + ': <code class="code-inline">%USERPROFILE%\\.aws\\sso\\cache\\</code></p>' +
      '<p>' + escapeHtml(t('local.macosLinux')) + ': <code class="code-inline">~/.aws/sso/cache/</code></p>' +
      '</div>' +
      '<div class="form-group"><label>' + escapeHtml(t('local.loginChannel')) + '</label>' +
      '<select id="localProvider">' +
      '<option value="BuilderId">' + escapeHtml(t('local.providerBuilderId')) + '</option>' +
      '<option value="Enterprise">' + escapeHtml(t('local.providerEnterprise')) + '</option>' +
      '<option value="Google">' + escapeHtml(t('local.providerGoogle')) + '</option>' +
      '<option value="Github">' + escapeHtml(t('local.providerGithub')) + '</option>' +
      '</select>' +
      '</div>' +
      '<div class="form-group">' +
      '<label>' + escapeHtml(t('local.tokenFile')) + ' <small>' + escapeHtml(t('local.tokenRequired')) + '</small></label>' +
      '<div class="input-row">' +
      '<textarea id="localTokenJson" placeholder="' + escapeAttr(t('local.pasteOrUpload')) + '" class="font-mono"></textarea>' +
      '<label class="btn btn-outline btn-sm">' + escapeHtml(t('local.upload')) +
      '<input type="file" accept=".json" id="localTokenFile" class="file-input-hidden" />' +
      '</label>' +
      '</div>' +
      '</div>' +
      '<div id="localClientGroup" class="form-group">' +
      '<label>' + escapeHtml(t('local.clientFile')) + ' <small>' + escapeHtml(t('local.clientRequired')) + '</small></label>' +
      '<div class="input-row">' +
      '<textarea id="localClientJson" placeholder="' + escapeAttr(t('local.pasteOrUpload')) + '" class="font-mono"></textarea>' +
      '<label class="btn btn-outline btn-sm">' + escapeHtml(t('local.upload')) +
      '<input type="file" accept=".json" id="localClientFile" class="file-input-hidden" />' +
      '</label>' +
      '</div>' +
      '</div>' +
      '<div class="modal-footer">' +
      '<button class="btn btn-secondary" data-modal-goto="add" type="button">' + escapeHtml(t('common.back')) + '</button>' +
      '<button class="btn btn-primary" id="importLocalBtn" type="button">' + escapeHtml(t('common.add')) + '</button>' +
      '</div>';
    $('localProvider').addEventListener('change', updateLocalFields);
    $('localTokenFile').addEventListener('change', e => loadLocalFile(e.target, 'localTokenJson'));
    $('localClientFile').addEventListener('change', e => loadLocalFile(e.target, 'localClientJson'));
    $('importLocalBtn').addEventListener('click', importLocalKiro);
  }
  function modalCredentials(title, body) {
    title.textContent = t('modal.credentialsTitle');
    body.innerHTML =
      '<p class="help-block">' + escapeHtml(t('modal.credentialsDesc')) + '</p>' +
      '<p class="help-block">' + escapeHtml(t('credentials.batchHint')) + '</p>' +
      '<div class="form-group"><label>' + escapeHtml(t('credentials.label')) + '</label>' +
      '<textarea id="credJson" class="font-mono" placeholder=\'[{"refreshToken":"xxx","provider":"BuilderID"}]&#10;or&#10;email----password----refreshToken----clientId----clientSecret\'></textarea>' +
      '</div>' +
      '<div class="modal-footer">' +
      '<button class="btn btn-secondary" data-modal-goto="add" type="button">' + escapeHtml(t('common.back')) + '</button>' +
      '<button class="btn btn-primary" id="importCredBtn" type="button">' + escapeHtml(t('common.add')) + '</button>' +
      '</div>';
    $('importCredBtn').addEventListener('click', importCredentials);
  }
  function modalCookie(title, body) {
    title.textContent = t('modal.cookieTitle');
    body.innerHTML =
      '<div class="help-block">' +
      '<p><b>' + escapeHtml(t('cookie.howToGet')) + '</b></p>' +
      '<ol class="steps-list">' +
      '<li>' + escapeHtml(t('cookie.step1')) + ' <a href="' + escapeAttr(t('cookie.link')) + '" target="_blank">' + escapeHtml(t('cookie.link')) + '</a></li>' +
      '<li>' + escapeHtml(t('cookie.step2')) + '</li>' +
      '<li>' + escapeHtml(t('cookie.step3')) + '</li>' +
      '</ol>' +
      '</div>' +
      '<div class="form-group"><label>' + escapeHtml(t('cookie.provider')) + '</label>' +
      '<select id="cookieProvider">' +
      '<option value="Google">' + escapeHtml(t('cookie.google')) + '</option>' +
      '<option value="Github">' + escapeHtml(t('cookie.github')) + '</option>' +
      '</select>' +
      '</div>' +
      '<div class="form-group"><label>' + escapeHtml(t('cookie.refreshToken')) + '</label>' +
      '<textarea id="cookieRefreshToken" class="font-mono" placeholder="' + escapeAttr(t('cookie.refreshTokenPlaceholder')) + '"></textarea>' +
      '</div>' +
      '<div class="modal-footer">' +
      '<button class="btn btn-secondary" data-modal-goto="add" type="button">' + escapeHtml(t('common.back')) + '</button>' +
      '<button class="btn btn-primary" id="importCookieBtn" type="button">' + escapeHtml(t('common.add')) + '</button>' +
      '</div>';
    $('importCookieBtn').addEventListener('click', importFromCookie);
  }
  function updateLocalFields() {
    const p = $('localProvider').value;
    $('localClientGroup').classList.toggle('hidden', p === 'Google' || p === 'Github');
  }
  function loadLocalFile(input, targetId) {
    const file = input.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = e => { $(targetId).value = e.target.result; };
    r.readAsText(file);
  }

  // Import handlers
  async function importLocalKiro() {
    const provider = $('localProvider').value;
    const tokenJson = $('localTokenJson').value.trim();
    const clientJson = $('localClientJson').value.trim();
    const isSocial = provider === 'Google' || provider === 'Github';
    if (!tokenJson) return toastWarning(t('local.tokenMissing'));
    let tokenData, clientData;
    try { tokenData = JSON.parse(tokenJson); } catch { return toastWarning(t('local.tokenInvalid')); }
    if (!tokenData.refreshToken) return toastWarning(t('local.refreshTokenMissing'));
    if (!isSocial) {
      if (!clientJson) return toastWarning(t('local.clientMissing'));
      try { clientData = JSON.parse(clientJson); } catch { return toastWarning(t('local.clientInvalid')); }
      if (!clientData.clientId || !clientData.clientSecret) return toastWarning(t('local.clientSecretMissing'));
    }
    const authMethod = clientData ? 'idc' : 'social';
    const payload = {
      refreshToken: tokenData.refreshToken,
      accessToken: tokenData.accessToken || '',
      clientId: clientData?.clientId || '',
      clientSecret: clientData?.clientSecret || '',
      region: tokenData.region || '',
      authMethod, provider
    };
    const res = await api('/auth/credentials', { method: 'POST', body: JSON.stringify(payload) });
    const d = await res.json();
    if (d.success) {
      closeModal(); loadAccounts(); loadStats();
      toastPrimary(t('local.importSuccess') + ': ' + (d.account?.email || d.account?.id));
      autoRefreshNewAccount(d.account?.id);
    } else toastError(t('common.failed') + ': ' + (d.error || ''));
  }
  async function importCredentials() {
    const raw = $('credJson').value.trim();
    if (!raw) { toastWarning(t('credentials.jsonError')); return; }
    let items;
    let skipped = 0;
    try {
      const json = JSON.parse(raw);
      if (json.accounts && Array.isArray(json.accounts)) {
        items = json.accounts.map(a => {
          const c = a.credentials || {};
          return {
            refreshToken: c.refreshToken || a.refreshToken,
            clientId: c.clientId || a.clientId,
            clientSecret: c.clientSecret || a.clientSecret,
            region: c.region || a.region,
            authMethod: c.authMethod || a.authMethod,
            provider: c.provider || a.provider || a.idp
          };
        });
      } else {
        items = Array.isArray(json) ? json : [json];
      }
    } catch {
      const parsed = parseLineCredentials(raw);
      items = parsed.items;
      skipped = parsed.skipped;
      if (items.length === 0 && skipped === 0) {
        toastWarning(t('credentials.jsonError'));
        return;
      }
      if (items.length === 0) {
        toastWarning(t('credentials.lineParseAllSkipped', skipped));
        return;
      }
    }
    let ok = 0, fail = 0, newIds = [];
    for (const item of items) {
      if (!item.refreshToken) { fail++; continue; }
      let authMethod = item.authMethod || '';
      if (item.clientId && item.clientSecret) authMethod = 'idc';
      else if (!authMethod || authMethod === 'social') authMethod = 'social';
      else authMethod = authMethod.toLowerCase() === 'idc' ? 'idc' : 'social';
      let provider = item.provider || '';
      if (!provider && authMethod === 'social') provider = 'Google';
      if (!provider && authMethod === 'idc') provider = 'BuilderId';
      const payload = {
        refreshToken: item.refreshToken,
        accessToken: item.accessToken || '',
        clientId: item.clientId || '',
        clientSecret: item.clientSecret || '',
        authMethod, provider,
        region: item.region || 'us-east-1'
      };
      try {
        const res = await api('/auth/credentials', { method: 'POST', body: JSON.stringify(payload) });
        const d = await res.json();
        if (d.success) { ok++; if (d.account?.id) newIds.push(d.account.id); }
        else fail++;
      } catch { fail++; }
    }
    closeModal(); loadAccounts(); loadStats();
    let msg = t('sso.importSuccess', ok);
    if (fail > 0) msg += t('sso.importPartial', fail);
    if (skipped > 0) msg += t('credentials.lineParseSkipped', skipped);
    toastPrimary(msg, { duration: 5200 });
    newIds.forEach(autoRefreshNewAccount);
  }
  function parseLineCredentials(text) {
    const items = [];
    let skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parts;
      if (trimmed.includes('----')) {
        parts = trimmed.split('----').map(s => s.trim());
      } else if (trimmed.includes('\t')) {
        parts = trimmed.split(/\t+/).map(s => s.trim());
      } else {
        parts = trimmed.split(/\s+/).map(s => s.trim());
      }
      if (parts.length < 5) { skipped++; continue; }
      const refreshToken = parts[2];
      if (!refreshToken) { skipped++; continue; }
      items.push({
        refreshToken,
        clientId: parts[3],
        clientSecret: parts[4],
      });
    }
    return { items, skipped };
  }
  async function importFromCookie() {
    const refreshToken = $('cookieRefreshToken').value.trim();
    if (!refreshToken) return toastWarning(t('cookie.refreshTokenMissing'));
    const provider = $('cookieProvider').value;
    const payload = { refreshToken, accessToken: '', clientId: '', clientSecret: '', authMethod: 'social', provider };
    const res = await api('/auth/credentials', { method: 'POST', body: JSON.stringify(payload) });
    const d = await res.json();
    if (d.success) {
      closeModal(); loadAccounts(); loadStats();
      toastPrimary(t('cookie.importSuccess') + ': ' + (d.account?.email || d.account?.id));
      autoRefreshNewAccount(d.account?.id);
    } else toastError(t('common.failed') + ': ' + (d.error || ''));
  }
  async function importSsoToken() {
    const res = await api('/auth/sso-token', {
      method: 'POST', body: JSON.stringify({
        bearerToken: $('ssoToken').value,
        region: $('ssoRegion').value
      })
    });
    const d = await res.json();
    if (d.success) {
      closeModal(); loadAccounts(); loadStats();
      const count = d.accounts?.length || 0;
      const errs = d.errors?.length || 0;
      let msg = t('sso.importSuccess', count);
      if (errs > 0) msg += t('sso.importPartial', errs);
      toastPrimary(msg, { duration: 5200 });
      if (d.accounts) d.accounts.forEach(a => autoRefreshNewAccount(a.id));
    } else toastError(t('common.failed') + ': ' + (d.error || ''));
  }
  async function startBuilderIdLogin() {
    const region = $('builderIdRegion').value || 'us-east-1';
    const res = await api('/auth/builderid/start', { method: 'POST', body: JSON.stringify({ region }) });
    const d = await res.json();
    if (d.sessionId) {
      builderIdSession = d.sessionId;
      $('builderIdUserCode').textContent = d.userCode;
      $('builderIdVerifyUrl').textContent = d.verificationUri;
      $('builderIdStep1').classList.add('hidden');
      $('builderIdStep2').classList.remove('hidden');
      $('builderIdOpenBtn').addEventListener('click', () => window.open($('builderIdVerifyUrl').textContent, '_blank'));
      $('builderIdCopyBtn').addEventListener('click', async () => {
        await copyText($('builderIdVerifyUrl').textContent);
        toast(t('common.copied'), 'primary');
      });
      $('builderIdCancelBtn').addEventListener('click', cancelBuilderIdLogin);
      pollBuilderIdAuth(d.interval || 5);
    } else toastError(t('common.failed') + ': ' + (d.error || ''));
  }
  function pollBuilderIdAuth(interval) {
    builderIdPollTimer = setTimeout(async () => {
      const res = await api('/auth/builderid/poll', { method: 'POST', body: JSON.stringify({ sessionId: builderIdSession }) });
      const d = await res.json();
      if (d.completed) {
        closeModal(); loadAccounts(); loadStats();
        toastPrimary(t('builderid.success') + ': ' + (d.account?.email || d.account?.id));
        autoRefreshNewAccount(d.account?.id);
      } else if (d.success && !d.completed) {
        $('builderIdStatus').textContent = t('builderid.waiting');
        pollBuilderIdAuth(d.interval || interval);
      } else {
        toastError(t('common.failed') + ': ' + (d.error || ''));
        cancelBuilderIdLogin();
      }
    }, interval * 1000);
  }
  function cancelBuilderIdLogin() {
    if (builderIdPollTimer) { clearTimeout(builderIdPollTimer); builderIdPollTimer = null; }
    builderIdSession = '';
    showModal('add');
  }
  async function startIamSso() {
    if (iamSession) {
      const res = await api('/auth/iam-sso/complete', {
        method: 'POST', body: JSON.stringify({
          sessionId: iamSession, callbackUrl: $('iamCallback').value
        })
      });
      const d = await res.json();
      if (d.success) {
        closeModal(); loadAccounts(); loadStats();
        toastPrimary(t('builderid.success') + ': ' + (d.account?.email || d.account?.id));
        autoRefreshNewAccount(d.account?.id);
      } else toastError(t('common.failed') + ': ' + (d.error || ''));
    } else {
      const res = await api('/auth/iam-sso/start', {
        method: 'POST', body: JSON.stringify({
          startUrl: $('iamStartUrl').value, region: $('iamRegion').value
        })
      });
      const d = await res.json();
      if (d.authorizeUrl) {
        iamSession = d.sessionId;
        $('iamAuthUrl').textContent = d.authorizeUrl;
        $('iamStep2').classList.remove('hidden');
        $('iamBtn').textContent = t('iam.complete');
        $('iamOpenBtn').addEventListener('click', () => window.open($('iamAuthUrl').textContent, '_blank'));
        $('iamCopyBtn').addEventListener('click', async () => {
          await copyText($('iamAuthUrl').textContent);
          toast(t('common.copied'), 'primary');
        });
      } else toastError(t('common.failed') + ': ' + (d.error || ''));
    }
  }
  async function autoRefreshNewAccount(id) {
    if (!id) return;
    try { await api('/accounts/' + id + '/refresh', { method: 'POST' }); } catch (e) { }
    loadAccounts();
  }

  // Export modal
  function showExportModal() {
    if (!accountsData.length) return toastWarning(t('accounts.empty'));
    exportSelectedIds = new Set(accountsData.map(a => a.id));
    renderExportModal();
    openDialog('exportModal');
  }
  function closeExportModal() { closeDialog('exportModal'); }
  function renderExportModal() {
    const body = $('exportBody');
    const all = exportSelectedIds.size === accountsData.length;
    body.innerHTML =
      '<div class="flex items-center justify-between mb-3">' +
      '<span class="text-sm muted-text">' + escapeHtml(t('export.selected', exportSelectedIds.size)) + '</span>' +
      '<button class="btn btn-sm btn-outline" id="exportToggleAllBtn" type="button">' + escapeHtml(all ? t('export.deselectAll') : t('export.selectAll')) + '</button>' +
      '</div>' +
      '<div class="export-list">' +
      accountsData.map(a => {
        const checked = exportSelectedIds.has(a.id);
        return '<label class="export-row' + (checked ? ' selected' : '') + '">' +
          '<input type="checkbox" ' + (checked ? 'checked' : '') + ' data-export-toggle="' + escapeAttr(a.id) + '" />' +
          '<div class="export-row-text">' +
          '<div class="export-row-email">' + escapeHtml(getDisplayEmail(a.email, a.id)) + '</div>' +
          '<div class="export-row-meta">' + escapeHtml(formatAuthMethod(a.provider || a.authMethod)) + ' · ' + escapeHtml(formatSubscriptionLabel(a.subscriptionType)) + '</div>' +
          '</div>' +
          '</label>';
      }).join('') +
      '</div>' +
      '<div id="exportJsonPreview" class="hidden mb-3"><textarea id="exportJsonText" readonly class="font-mono"></textarea></div>' +
      '<div class="modal-footer">' +
      '<button class="btn btn-secondary" id="exportCloseBtn" type="button">' + escapeHtml(t('common.cancel')) + '</button>' +
      '<button class="btn btn-outline" id="exportShowJsonBtn" type="button">' + escapeHtml(t('export.showJson')) + '</button>' +
      '<button class="btn btn-outline" id="exportCopyJsonBtn" type="button">' + escapeHtml(t('export.copyJson')) + '</button>' +
      '<button class="btn btn-primary" id="exportDownloadBtn" type="button">' + escapeHtml(t('export.downloadJson')) + '</button>' +
      '</div>';
    $('exportToggleAllBtn').addEventListener('click', () => {
      if (exportSelectedIds.size === accountsData.length) exportSelectedIds.clear();
      else exportSelectedIds = new Set(accountsData.map(a => a.id));
      renderExportModal();
    });
    $('exportCloseBtn').addEventListener('click', closeExportModal);
    $('exportShowJsonBtn').addEventListener('click', exportShowJson);
    $('exportCopyJsonBtn').addEventListener('click', exportCopyJson);
    $('exportDownloadBtn').addEventListener('click', exportDownloadJson);
    qsa('[data-export-toggle]', body).forEach(cb => cb.addEventListener('change', e => {
      const id = e.target.dataset.exportToggle;
      if (exportSelectedIds.has(id)) exportSelectedIds.delete(id);
      else exportSelectedIds.add(id);
      renderExportModal();
    }));
  }
  async function getExportData() {
    if (exportSelectedIds.size === 0) { toastWarning(t('export.noSelection')); return null; }
    const res = await api('/export', { method: 'POST', body: JSON.stringify({ ids: Array.from(exportSelectedIds) }) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toastError(t('common.failed') + ': ' + (err.error || t('common.unknownError')));
      return null;
    }
    return res.json();
  }
  async function exportShowJson() {
    const data = await getExportData();
    if (!data) return;
    $('exportJsonPreview').classList.remove('hidden');
    $('exportJsonText').value = JSON.stringify(data, null, 2);
  }
  async function exportCopyJson() {
    if (exportSelectedIds.size === 0) { toastWarning(t('export.noSelection')); return; }
    const jsonPromise = getExportData().then(data => {
      if (!data) throw new Error('no-data');
      const filtered = (data.accounts || []).map(a => {
        const { clientId, clientSecret, accessToken, refreshToken } = a.credentials || {};
        return { clientId, clientSecret, accessToken, refreshToken };
      });
      return JSON.stringify(filtered, null, 2);
    });
    try {
      await copyText(jsonPromise);
      toast(t('export.copied'), 'primary');
    } catch (e) {
      if (e && e.message !== 'no-data') toastError(t('common.failed'));
    }
  }
  async function exportDownloadJson() {
    const data = await getExportData();
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kiro-accounts-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  // Version and update
  function renderVersionBadge() {
    const badge = $('versionBadge');
    if (badge && currentVersion) badge.textContent = currentVersion.replace(/^v/i, '');
  }
  async function loadVersion() {
    try {
      const res = await api('/version');
      const d = await res.json();
      currentVersion = d.version || '';
      renderVersionBadge();
    } catch (e) { }
  }
  function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0, nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }
  function setUpdateButtonLoading(loading) {
    const btn = $('checkUpdateBtn');
    if (!btn) return;
    btn.disabled = loading;
    if (loading) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
    const label = btn.querySelector('[data-update-label]');
    const icon = btn.querySelector('i');
    if (label) label.textContent = t(loading ? 'update.checking' : 'update.check');
    if (icon) icon.classList.toggle('fa-spin', loading);
  }
  async function checkUpdate(manual) {
    if (manual) setUpdateButtonLoading(true);
    try {
      if (!currentVersion) await loadVersion();
      const current = currentVersion.replace(/^v/i, '');
      if (!current) throw new Error('Current version missing');
      const res = await fetch('https://raw.githubusercontent.com/lenhanpham/SuperKiro/main/version.json?t=' + Date.now());
      if (!res.ok) throw new Error('Fetch failed');
      const d = await res.json();
      const latest = (d.version || '').replace(/^v/i, '');
      if (!latest) throw new Error('Latest version missing');
      if (latest && latest !== current && compareVersions(latest, current) > 0) {
        if (manual) showUpdateModal(latest, d.download, d.changelog);
        else showUpdateToast('available', current, latest);
      } else if (manual) {
        showUpdateToast('current', current, latest || current);
      }
    } catch (e) {
      if (manual) showUpdateToast('error', '', '');
    } finally {
      if (manual) setUpdateButtonLoading(false);
    }
  }
  function showUpdateToast(status, current, latest) {
    if (status === 'available') {
      toast(t('update.availableToast') + (latest ? ': ' + latest : ''), 'warning', {
        icon: 'fa-solid fa-arrow-up',
        duration: 5200,
        onClick: function () { checkUpdate(true); }
      });
      return;
    }
    if (status === 'current') {
      toast(t('update.noUpdatesToast'), 'success', {
        icon: 'fa-solid fa-circle-check',
        duration: 3600
      });
      return;
    }
    toast(t('update.checkFailed'), 'error', {
      icon: 'fa-solid fa-triangle-exclamation',
      duration: 4200
    });
  }
  function showUpdateModal(version, url, changelog) {
    const current = currentVersion.replace(/^v/i, '');
    $('updateBody').innerHTML =
      '<div class="update-shell">' +
      '<div class="update-hero">' +
      '<div class="update-result-icon update-result-info"><i class="fa-solid fa-arrow-up"></i></div>' +
      '<div>' +
      '<h3 class="update-hero-title">' + escapeHtml(t('update.newVersion')) + '</h3>' +
      '<p class="update-hero-copy">' + escapeHtml(t('update.newVersionMessage')) + '</p>' +
      '</div>' +
      '</div>' +
      '<div class="update-version-grid">' +
      '<div class="update-version-card update-version-card-current"><p class="update-version-label">' + escapeHtml(t('update.current')) + '</p><p class="update-version-value update-version-value-current">' + escapeHtml(current) + '</p></div>' +
      '<div class="update-version-card update-version-card-latest"><p class="update-version-label">' + escapeHtml(t('update.latest')) + '</p><p class="update-version-value update-version-value-success">' + escapeHtml(version) + '</p></div>' +
      '</div>' +
      (changelog ? '<div class="update-notes"><p class="update-notes-title">' + escapeHtml(t('update.changelog')) + '</p><p class="update-notes-body">' + escapeHtml(changelog) + '</p></div>' : '') +
      '<div class="update-actions"><a href="' + escapeAttr(url) + '" target="_blank" rel="noopener" class="btn btn-primary">' + escapeHtml(t('update.goDownload')) + '</a></div>' +
      '</div>';
    openDialog('updateModal');
  }
  function showUpdateStatusModal(status, title, message, latest) {
    const current = currentVersion.replace(/^v/i, '');
    const isError = status === 'error';
    $('updateBody').innerHTML =
      '<div class="update-shell">' +
      '<div class="text-center mb-5">' +
      '<div class="update-result-icon update-status-icon update-result-' + (isError ? 'error' : 'success') + '">' +
      '<i class="fa-solid ' + (isError ? 'fa-triangle-exclamation' : 'fa-circle-check') + '"></i>' +
      '</div>' +
      '<p class="text-base font-semibold ' + (isError ? 'danger-text' : 'success-text') + '">' + escapeHtml(title) + '</p>' +
      '<p class="text-sm mt-2 muted-text">' + escapeHtml(message) + '</p>' +
      '</div>' +
      '<div class="update-version-grid">' +
      '<div class="update-version-card update-version-card-current"><p class="update-version-label">' + escapeHtml(t('update.current')) + '</p><p class="update-version-value update-version-value-current">' + escapeHtml(current || '-') + '</p></div>' +
      '<div class="update-version-card' + (!isError ? ' update-version-card-latest' : '') + '"><p class="update-version-label">' + escapeHtml(t('update.latest')) + '</p><p class="update-version-value' + (!isError ? ' update-version-value-success' : '') + '">' + escapeHtml(latest || '-') + '</p></div>' +
      '</div>' +
      '</div>';
    openDialog('updateModal');
  }
  function closeUpdateModal() { closeDialog('updateModal'); }

  // Tabs
  function switchTab(tab) {
    qsa('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    qsa('.tab-content').forEach(c => c.classList.add('hidden'));
    $('tab' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.remove('hidden');
    if (tab === 'combos') { loadCombos(); }
    if (tab === 'api') { renderCliTools(); if (apiKeysCache.length === 0) loadApiKeys(); loadCliToolStatus(); }
  }

  // CLI Tools
  // ---- CLI Tool State ----
  let cliApiKeyCache = {};
  let cliToolDetailId = null;

  // ---- Helper: get API key from select/input ----
  async function getCliApiKey(selectId, customId) {
    var sel = $(selectId);
    if (!sel) return '';
    if (sel.value === 'custom') {
      var inp = $(customId);
      return inp ? inp.value.trim() : '';
    }
    if (sel.value) {
      var keyId = sel.value;
      if (cliApiKeyCache[keyId]) return cliApiKeyCache[keyId];
      try {
        var res = await api('/cli-tools/apikey/' + encodeURIComponent(keyId));
        if (res.ok) {
          var d = await res.json();
          cliApiKeyCache[keyId] = d.key;
          return d.key;
        }
      } catch (e) {}
    }
    return '';
  }

  // ---- Helper: render endpoint select + API key select (used by many tools) ----
  function renderEndpointApiKeyFields(prefix) {
    var localUrl = (baseUrl || location.origin) + '/v1';
    var html = '';
    html += '<div class="form-group"><label data-i18n="cliTools.endpoint"></label>' +
      '<select id="' + prefix + '_ep" class="form-control" data-native-select="true">' +
      '<option value="local">' + escapeHtml(localUrl) + '</option>' +
      '<option value="custom" data-i18n="cliTools.customUrl"></option></select>' +
      '<input type="text" id="' + prefix + '_epCustom" class="form-control hidden" style="margin-top:0.4rem;" data-i18n-placeholder="cliTools.endpointPlaceholder" placeholder="https://example.com/v1" autocomplete="off" /></div>';
    html += '<div class="form-group"><label data-i18n="cliTools.apiKey"></label>' +
      '<select id="' + prefix + '_ak" class="form-control" data-native-select="true">' +
      '<option value="">--</option><option value="custom" data-i18n="cliTools.customUrl"></option></select>' +
      '<input type="text" id="' + prefix + '_akCustom" class="form-control hidden" style="margin-top:0.4rem;" data-i18n-placeholder="cliTools.apiKeyPlaceholder" placeholder="sk-..." autocomplete="off" /></div>';
    return html;
  }

  function bindEndpointApiKeyEvents(prefix) {
    var ep = $(prefix + '_ep');
    var ak = $(prefix + '_ak');
    if (ep) ep.addEventListener('change', function () {
      var c = $(prefix + '_epCustom');
      if (c) c.classList.toggle('hidden', this.value !== 'custom');
    });
    if (ak) ak.addEventListener('change', function () {
      var c = $(prefix + '_akCustom');
      if (c) c.classList.toggle('hidden', this.value !== 'custom');
    });
  }

  function populateAkSelect(prefix) {
    var ak = $(prefix + '_ak');
    if (!ak) return;
    var prevVal = ak.value;
    while (ak.options.length > 2) ak.remove(2);
    (apiKeysCache || []).forEach(function (k) {
      var opt = document.createElement('option');
      opt.value = k.id;
      opt.textContent = (k.name ? k.name + ' - ' : '') + k.keyMasked;
      ak.appendChild(opt);
    });
    if (prevVal && Array.from(ak.options).some(function (o) { return o.value === prevVal; })) {
      ak.value = prevVal;
    } else {
      ak.value = '';
      var c = $(prefix + '_akCustom');
      if (c) { c.classList.add('hidden'); c.value = ''; }
    }
  }

  function getEndpointValue(prefix) {
    var ep = $(prefix + '_ep');
    if (!ep) return '';
    if (ep.value === 'custom') {
      var c = $(prefix + '_epCustom');
      return c ? c.value.trim() : '';
    }
    return ep.options[ep.selectedIndex].textContent;
  }

  function getAkValue(prefix) {
    var ak = $(prefix + '_ak');
    if (!ak) return '';
    if (ak.value === 'custom') {
      var c = $(prefix + '_akCustom');
      return c ? c.value.trim() : '';
    }
    if (ak.value) return ak.value;
    return '';
  }

  // ---- Helper: render manual config modal ----
  function showManualConfigModal(configs) {
    var body = $('cliManualConfigBody');
    body.innerHTML = '<p class="cli-manual-config-hint" data-i18n="cliTools.manualConfigHint"></p>';
    applyTranslations();
    configs.forEach(function (cfg) {
      var div = document.createElement('div');
      div.className = 'cli-manual-config-entry';
      var filenameDiv = document.createElement('div');
      filenameDiv.className = 'cli-manual-config-filename';
      filenameDiv.innerHTML = '<i class="fa-regular fa-file-lines"></i> ' + escapeHtml(cfg.filename) +
        ' <button class="cli-manual-config-copy-btn" type="button"><i class="fa-regular fa-copy"></i> <span data-i18n="cliTools.copyConfig"></span></button>';
      div.appendChild(filenameDiv);
      var code = document.createElement('pre');
      code.className = 'cli-manual-config-code';
      code.textContent = cfg.content;
      div.appendChild(code);
      body.appendChild(div);
    });
    applyTranslations();
    body.querySelectorAll('.cli-manual-config-copy-btn').forEach(function (btn, i) {
      btn.addEventListener('click', function () {
        var code = body.querySelectorAll('.cli-manual-config-code')[i];
        if (!code) return;
        copyText(code.textContent).then(function () {
          var span = btn.querySelector('span');
          if (span) span.textContent = t('cliTools.copied');
          setTimeout(function () {
            if (span) span.textContent = t('cliTools.copyConfig');
          }, 2000);
        }).catch(function () {});
      });
    });
    openDialog('cliManualConfigModal');
  }

  // ---- Helper: show tool status in expanded card ----
  function showToolStatus(prefix, message, type) {
    var el = $(prefix + '_status');
    if (!el) return;
    el.className = 'cli-tool-status-' + (type || 'success') + ' hidden';
    el.textContent = message || '';
    el.classList.remove('hidden');
  }

  function claudeManualConfig(endpoint, apiKey, opus, sonnet, haiku) {
    var env = { ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: apiKey };
    if (opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
    if (sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
    if (haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
    return [{ filename: '~/.claude/settings.json', content: JSON.stringify({ hasCompletedOnboarding: true, env: env }, null, 2) }];
  }

  // ================================================================
  // CLAUDE CODE — dedicated config
  // ================================================================
  function renderClaudeConfig() {
    var prefix = 'claude';
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>';
    var slots = [
      { key: 'opus', label: t('cliTools.opus'), param: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
      { key: 'sonnet', label: t('cliTools.sonnet'), param: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
      { key: 'haiku', label: t('cliTools.haiku'), param: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' }
    ];
    var claudeState = window.claudeSlotState || {};
    slots.forEach(function (s, idx) {
      var val = claudeState[s.key] || '';
      html += '<div class="cli-model-slot" style="display:flex;gap:0.5rem;align-items:center;margin-top:' + (idx > 0 ? '0.5rem' : '0.5rem') + ';">' +
        '<span style="font-size:0.75rem;font-weight:600;color:var(--muted-foreground);min-width:3.5rem;">' + s.label + '</span>' +
        '<input type="text" class="form-control claude-slot-input" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(val) + '" autocomplete="off" data-slot="' + s.key + '" />' +
        (val ? '<button class="btn btn-outline btn-sm claude-slot-clear" type="button" data-slot="' + s.key + '" style="padding:0.25rem 0.5rem;" data-i18n-title="cliTools.clear" title="Clear">&times;</button>' : '') +
        '<button class="btn btn-outline btn-sm claude-slot-select" type="button" data-slot="' + s.key + '" data-i18n="cliTools.selectModel"></button>' +
        '</div>';
    });
    html += '</div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
      '<button class="btn btn-secondary" onclick="claudeShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '<button class="btn btn-outline" onclick="claudeReset()" type="button" data-i18n="cliTools.reset"></button>' +
      '<button class="btn btn-primary" onclick="claudeApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '</div></div>';
    return html;
  }

  window.claudeSlotState = {};
  window.claudeApply = async function () {
    var prefix = 'claude';
    populateAkSelect(prefix);
    var endpoint = getEndpointValue(prefix);
    if (!endpoint) { showToolStatus(prefix, 'Please select an endpoint', 'error'); return; }
    var apiKey = await getCliApiKey(prefix + '_ak', prefix + '_akCustom');
    var state = window.claudeSlotState || {};
    var env = { ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: apiKey };
    if (state.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = state.opus;
    if (state.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = state.sonnet;
    if (state.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = state.haiku;
    var applyBtn = document.querySelector('.cli-tool-detail-body .btn-primary');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = t('cliTools.applying'); }
    try {
      var res = await api('/cli-tools/claude', { method: 'POST', body: JSON.stringify({ env: env }) });
      if (res.ok) {
        showToolStatus(prefix, t('cliTools.configSuccess'), 'success');
        updateCliBadge('claude', true);
      } else {
        var d = await res.json().catch(function () { return {}; });
        showToolStatus(prefix, (d && d.error) || t('cliTools.configFailed'), 'error');
      }
    } catch (e) {
      showToolStatus(prefix, e.message || t('cliTools.configFailed'), 'error');
    } finally {
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('cliTools.apply'); }
    }
  };
  window.claudeShowManual = async function () {
    populateAkSelect('claude');
    var endpoint = getEndpointValue('claude');
    var apiKey = await getCliApiKey('claude_ak', 'claude_akCustom');
    var state = window.claudeSlotState || {};
    showManualConfigModal(claudeManualConfig(endpoint, apiKey || 'sk-your-api-key', state.opus || '', state.sonnet || '', state.haiku || ''));
  };
  window.claudeReset = async function () {
    var confirmed = await confirmAction('Reset Claude Code configuration?', { confirmText: 'Reset', variant: 'danger' });
    if (!confirmed) return;
    try {
      var res = await api('/cli-tools/claude', { method: 'DELETE' });
      if (res.ok) { showToolStatus('claude', 'Configuration reset', 'success'); updateCliBadge('claude', false); }
    } catch (e) {}
  };

  // ================================================================
  // OPENCODE — dedicated config
  // ================================================================
  function renderOpenCodeConfig() {
    var prefix = 'opencode';
    var state = window.__openCodeState || { models: [], activeModel: '', subagentModel: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>';
    html += '<div id="ocModels" style="display:flex;flex-wrap:wrap;gap:0.4rem;padding:0.5rem;border:1px solid var(--border);border-radius:6px;margin-bottom:0.5rem;min-height:2rem;">';
    if (state.models.length === 0) html += '<span style="font-size:0.8rem;color:var(--muted-foreground);" data-i18n="cliTools.noModels">No models selected.</span>';
    state.models.forEach(function (m) {
      var isActive = m === state.activeModel;
      html += '<span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.15rem 0.5rem;font-size:0.75rem;border-radius:4px;cursor:pointer;' + (isActive ? 'background:var(--primary);color:#fff;' : 'background:var(--muted);color:var(--foreground);border:1px solid var(--border);') + '" onclick="ocToggleActive(\'' + escapeAttr(m) + '\')">' +
        (isActive ? '<i class="fa-solid fa-star" style="font-size:0.6rem;"></i> ' : '') + escapeHtml(m) +
        '<i class="fa-solid fa-xmark" style="cursor:pointer;margin-left:0.2rem;font-size:0.65rem;" onclick="event.stopPropagation();ocRemoveModel(\'' + escapeAttr(m) + '\')"></i></span>';
    });
    html += '</div>';
    html += '<div style="margin-bottom:0.5rem;">' +
      '<button class="btn btn-outline btn-sm" onclick="ocSelectModel()" type="button" data-i18n="cliTools.selectModels">Select Models</button></div>';
    html += '<div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.4rem;">' +
      '<span style="font-size:0.75rem;font-weight:600;color:var(--muted-foreground);min-width:5rem;" data-i18n="cliTools.active">Active:</span>' +
      '<input type="text" class="form-control" style="flex:1;" value="' + escapeAttr(state.activeModel) + '" oninput="window.__openCodeState.activeModel=this.value" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" /></div>';
    html += '<div style="display:flex;gap:0.5rem;align-items:center;">' +
      '<span style="font-size:0.75rem;font-weight:600;color:var(--muted-foreground);min-width:5rem;" data-i18n="cliTools.subagent">Subagent:</span>' +
      '<input type="text" id="ocSubagentInput" class="form-control" style="flex:1;" value="' + escapeAttr(state.subagentModel) + '" oninput="window.__openCodeState.subagentModel=this.value" data-i18n-placeholder="cliTools.subagentPlaceholder" placeholder="Same as active" />' +
      '<button class="btn btn-outline btn-sm" onclick="ocSelectSubagentModel()" type="button" data-i18n="cliTools.selectModel">Select Model</button>' +
      (state.subagentModel ? '<button class="btn btn-outline btn-sm" onclick="ocClearSubagent()" type="button" style="padding:0.25rem 0.5rem;" title="" data-i18n-title="cliTools.clear">&times;</button>' : '') +
      '</div>';
    html += '</div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
      '<button class="btn btn-secondary" onclick="ocShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '<button class="btn btn-outline" onclick="ocReset()" type="button" data-i18n="cliTools.reset"></button>' +
      '<button class="btn btn-primary" onclick="ocApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '</div></div>';
    return html;
  }

  window.__openCodeState = { models: [], activeModel: '', subagentModel: '' };
  window.ocToggleActive = function (model) {
    var s = window.__openCodeState;
    s.activeModel = s.activeModel === model ? '' : model;
    reRenderDetailBody();
  };
  window.ocRemoveModel = function (model) {
    var s = window.__openCodeState;
    s.models = s.models.filter(function (m) { return m !== model; });
    if (s.activeModel === model) s.activeModel = s.models.length > 0 ? s.models[0] : '';
    reRenderDetailBody();
  };
  window.ocSelectModel = function () {
    openModelPicker();
  };
  window.ocSelectSubagentModel = function () {
    window.__cliModelCallback = function (model) {
      window.__openCodeState.subagentModel = model;
      closeDialog('modelPickerModal');
      reRenderDetailBody();
    };
    openModelPicker();
  };
  window.ocClearSubagent = function () {
    window.__openCodeState.subagentModel = '';
    var inp = document.getElementById('ocSubagentInput');
    if (inp) inp.value = '';
    reRenderDetailBody();
  };
  function bindOcEvents() {
    var prefix = 'opencode';
    bindEndpointApiKeyEvents(prefix);
  }
  window.ocApply = async function () {
    var prefix = 'opencode';
    populateAkSelect(prefix);
    var endpoint = getEndpointValue(prefix);
    if (!endpoint) { showToolStatus(prefix, 'Please select an endpoint', 'error'); return; }
    var apiKey = await getCliApiKey(prefix + '_ak', prefix + '_akCustom');
    var s = window.__openCodeState;
    var payload = { baseUrl: endpoint, apiKey: apiKey || null, models: s.models, activeModel: s.activeModel, subagentModel: s.subagentModel };
    var applyBtn = document.querySelector('.cli-tool-detail-body .btn-primary');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = t('cliTools.applying'); }
    try {
      var res = await api('/cli-tools/opencode', { method: 'POST', body: JSON.stringify(payload) });
      if (res.ok) { showToolStatus(prefix, t('cliTools.configSuccess'), 'success'); updateCliBadge('opencode', true); }
      else { var d = await res.json().catch(function () { return {}; }); showToolStatus(prefix, (d && d.error) || t('cliTools.configFailed'), 'error'); }
    } catch (e) { showToolStatus(prefix, e.message || t('cliTools.configFailed'), 'error'); }
    finally { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('cliTools.apply'); } }
  };
  window.ocShowManual = async function () {
    populateAkSelect('opencode');
    var endpoint = getEndpointValue('opencode');
    var apiKey = await getCliApiKey('opencode_ak', 'opencode_akCustom');
    var s = window.__openCodeState;
    var models = s.models.length > 0 ? s.models : ['provider/model-id'];
    var activeModel = s.activeModel || models[0];
    var subagentModel = s.subagentModel || activeModel;
    var modelsObj = {};
    models.forEach(function (m) { modelsObj[m] = { name: m, modalities: { input: ['text', 'image'], output: ['text'] } }; });
    showManualConfigModal([{
      filename: '~/.config/opencode/opencode.json',
      content: JSON.stringify({
        provider: { superkiro: { npm: '@ai-sdk/openai-compatible', options: { baseURL: endpoint, apiKey: apiKey }, models: modelsObj } },
        model: 'superkiro/' + activeModel,
        agent: { explorer: { description: 'Fast explorer subagent for codebase exploration', mode: 'subagent', model: 'superkiro/' + subagentModel } }
      }, null, 2)
    }]);
  };
  window.ocReset = async function () {
    var confirmed = await confirmAction('Reset OpenCode configuration?', { confirmText: 'Reset', variant: 'danger' });
    if (!confirmed) return;
    try { var res = await api('/cli-tools/opencode', { method: 'DELETE' }); if (res.ok) { showToolStatus('opencode', 'Configuration reset', 'success'); updateCliBadge('opencode', false); } } catch (e) {}
  };

  // ================================================================
  // CLINE — dedicated config
  // ================================================================
  function renderClineConfig() {
    var prefix = 'cline';
    var state = window.__clineState || { model: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;gap:0.5rem;">' +
      '<input type="text" id="clineModel" class="form-control" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(state.model) + '" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="clinePickModel()" type="button" data-i18n="cliTools.selectModel"></button></div></div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
      '<button class="btn btn-secondary" onclick="clineShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '<button class="btn btn-outline" onclick="clineReset()" type="button" data-i18n="cliTools.reset"></button>' +
      '<button class="btn btn-primary" onclick="clineApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '</div></div>';
    return html;
  }
  window.__clineState = { model: '' };
  window.clinePickModel = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        var inp = document.getElementById('clineModel');
        if (inp) inp.value = model;
        window.__clineState.model = model;
        closeDialog('modelPickerModal');
      };
      openModelPicker();
    }
  };
  window.clineApply = async function () {
    var prefix = 'cline';
    populateAkSelect(prefix);
    var endpoint = getEndpointValue(prefix);
    if (!endpoint) { showToolStatus(prefix, 'Please select an endpoint', 'error'); return; }
    var apiKey = await getCliApiKey(prefix + '_ak', prefix + '_akCustom');
    var model = window.__clineState.model || '';
    var applyBtn = document.querySelector('.cli-tool-detail-body .btn-primary');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = t('cliTools.applying'); }
    try {
      var res = await api('/cli-tools/cline', { method: 'POST', body: JSON.stringify({ baseUrl: endpoint, apiKey: apiKey || null, model: model }) });
      if (res.ok) { showToolStatus(prefix, t('cliTools.configSuccess'), 'success'); updateCliBadge('cline', true); }
      else { var d = await res.json().catch(function () { return {}; }); showToolStatus(prefix, (d && d.error) || t('cliTools.configFailed'), 'error'); }
    } catch (e) { showToolStatus(prefix, e.message || t('cliTools.configFailed'), 'error'); }
    finally { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('cliTools.apply'); } }
  };
  window.clineShowManual = async function () {
    populateAkSelect('cline');
    var endpoint = getEndpointValue('cline');
    var apiKey = await getCliApiKey('cline_ak', 'cline_akCustom');
    var model = window.__clineState.model || 'provider/model-id';
    var baseWithoutV1 = endpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    showManualConfigModal([
      { filename: '~/.cline/data/globalState.json', content: JSON.stringify({ actModeApiProvider: 'openai', planModeApiProvider: 'openai', openAiBaseUrl: baseWithoutV1, openAiModelId: model, planModeOpenAiModelId: model }, null, 2) },
      { filename: '~/.cline/data/secrets.json', content: JSON.stringify({ openAiApiKey: apiKey }, null, 2) }
    ]);
  };
  window.clineReset = async function () {
    var confirmed = await confirmAction('Reset Cline configuration?', { confirmText: 'Reset', variant: 'danger' });
    if (!confirmed) return;
    try { var res = await api('/cli-tools/cline', { method: 'DELETE' }); if (res.ok) { showToolStatus('cline', 'Configuration reset', 'success'); updateCliBadge('cline', false); } } catch (e) {}
  };

  // ================================================================
  // CODEX — dedicated config
  // ================================================================
  function renderCodexConfig() {
    var prefix = 'codex';
    var state = window.__codexState || { model: '', subagentModel: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;gap:0.5rem;align-items:center;">' +
      '<div style="flex:1;position:relative;">' +
      '<input type="text" id="codexModel" class="form-control" style="width:100%;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(state.model) + '" autocomplete="off" />' +
      (state.model ? '<button onclick="codexClearModel()" type="button" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);padding:2px 6px;border:none;background:none;cursor:pointer;font-size:0.85rem;color:var(--muted-foreground);">&times;</button>' : '') +
      '</div>' +
      '<button class="btn btn-outline btn-sm" onclick="codexPickModel()" type="button" data-i18n="cliTools.selectModel"></button></div></div>';
    html += '<div class="form-group"><label data-i18n="cliTools.codexSubagentModel">Subagent Model</label>' +
      '<div style="display:flex;gap:0.5rem;align-items:center;">' +
      '<div style="flex:1;position:relative;">' +
      '<input type="text" id="codexSubagent" class="form-control" style="width:100%;" data-i18n-placeholder="cliTools.codexSubagentPlace" placeholder="Same as main model" value="' + escapeAttr(state.subagentModel) + '" autocomplete="off" />' +
      (state.subagentModel ? '<button onclick="codexClearSubagent()" type="button" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);padding:2px 6px;border:none;background:none;cursor:pointer;font-size:0.85rem;color:var(--muted-foreground);">&times;</button>' : '') +
      '</div>' +
      '<button class="btn btn-outline btn-sm" onclick="codexPickSubagent()" type="button" data-i18n="cliTools.codexSelect">Select</button></div></div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
      '<button class="btn btn-secondary" onclick="codexShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '<button class="btn btn-outline" onclick="codexReset()" type="button" data-i18n="cliTools.reset"></button>' +
      '<button class="btn btn-primary" onclick="codexApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '</div></div>';
    return html;
  }
  window.__codexState = { model: '', subagentModel: '' };
  window.codexPickModel = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        window.__codexState.model = model;
        if (!window.__codexState.subagentModel) {
          window.__codexState.subagentModel = model;
        }
        closeDialog('modelPickerModal');
        reRenderDetailBody();
      };
      openModelPicker();
    }
  };
  window.codexClearModel = function () {
    window.__codexState.model = '';
    reRenderDetailBody();
  };
  window.codexPickSubagent = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        window.__codexState.subagentModel = model;
        closeDialog('modelPickerModal');
        reRenderDetailBody();
      };
      openModelPicker();
    }
  };
  window.codexClearSubagent = function () {
    window.__codexState.subagentModel = '';
    reRenderDetailBody();
  };
  window.codexApply = async function () {
    var prefix = 'codex';
    populateAkSelect(prefix);
    var endpoint = getEndpointValue(prefix);
    if (!endpoint) { showToolStatus(prefix, 'Please select an endpoint', 'error'); return; }
    var apiKey = await getCliApiKey(prefix + '_ak', prefix + '_akCustom');
    var model = window.__codexState.model || '';
    var subagentModel = window.__codexState.subagentModel || model;
    var applyBtn = document.querySelector('.cli-tool-detail-body .btn-primary');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = t('cliTools.applying'); }
    try {
      var res = await api('/cli-tools/codex', { method: 'POST', body: JSON.stringify({ baseUrl: endpoint, apiKey: apiKey || null, model: model, subagentModel: subagentModel }) });
      if (res.ok) { showToolStatus(prefix, t('cliTools.configSuccess'), 'success'); updateCliBadge('codex', true); }
      else { var d = await res.json().catch(function () { return {}; }); showToolStatus(prefix, (d && d.error) || t('cliTools.configFailed'), 'error'); }
    } catch (e) { showToolStatus(prefix, e.message || t('cliTools.configFailed'), 'error'); }
    finally { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('cliTools.apply'); } }
  };
  window.codexShowManual = async function () {
    populateAkSelect('codex');
    var endpoint = getEndpointValue('codex');
    var apiKey = await getCliApiKey('codex_ak', 'codex_akCustom');
    var model = window.__codexState.model || 'provider/model-id';
    var subagentModel = window.__codexState.subagentModel || model;
    var configContent = '# SuperKiro Configuration for Codex CLI\nmodel = "' + model + '"\nmodel_provider = "superkiro"\n\n[model_providers.superkiro]\nname = "SuperKiro"\nbase_url = "' + endpoint + '"\nwire_api = "responses"\n\n[agents.subagent]\nmodel = "' + subagentModel + '"\n';
    showManualConfigModal([
      { filename: '~/.codex/config.toml', content: configContent },
      { filename: '~/.codex/auth.json', content: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }, null, 2) }
    ]);
  };
  window.codexReset = async function () {
    var confirmed = await confirmAction('Reset Codex configuration?', { confirmText: 'Reset', variant: 'danger' });
    if (!confirmed) return;
    try { var res = await api('/cli-tools/codex', { method: 'DELETE' }); if (res.ok) { showToolStatus('codex', 'Configuration reset', 'success'); updateCliBadge('codex', false); } } catch (e) {}
  };

  // ================================================================
  // KILO CODE — dedicated config
  // ================================================================
  function renderKiloConfig() {
    var prefix = 'kilo';
    var state = window.__kiloState || { model: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;gap:0.5rem;">' +
      '<input type="text" id="kiloModel" class="form-control" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(state.model) + '" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="kiloPickModel()" type="button" data-i18n="cliTools.selectModel"></button></div></div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
      '<button class="btn btn-secondary" onclick="kiloShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '<button class="btn btn-outline" onclick="kiloReset()" type="button" data-i18n="cliTools.reset"></button>' +
      '<button class="btn btn-primary" onclick="kiloApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '</div></div>';
    return html;
  }
  window.__kiloState = { model: '' };
  window.kiloPickModel = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        document.getElementById('kiloModel').value = model;
        window.__kiloState.model = model;
        closeDialog('modelPickerModal');
      };
      openModelPicker();
    }
  };
  window.kiloApply = async function () {
    var prefix = 'kilo';
    populateAkSelect(prefix);
    var endpoint = getEndpointValue(prefix);
    if (!endpoint) { showToolStatus(prefix, 'Please select an endpoint', 'error'); return; }
    var apiKey = await getCliApiKey(prefix + '_ak', prefix + '_akCustom');
    var model = window.__kiloState.model || '';
    var applyBtn = document.querySelector('.cli-tool-detail-body .btn-primary');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = t('cliTools.applying'); }
    try {
      var res = await api('/cli-tools/kilocode', { method: 'POST', body: JSON.stringify({ baseUrl: endpoint, apiKey: apiKey || null, model: model }) });
      if (res.ok) { showToolStatus(prefix, t('cliTools.configSuccess'), 'success'); updateCliBadge('kilo', true); }
      else { var d = await res.json().catch(function () { return {}; }); showToolStatus(prefix, (d && d.error) || t('cliTools.configFailed'), 'error'); }
    } catch (e) { showToolStatus(prefix, e.message || t('cliTools.configFailed'), 'error'); }
    finally { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('cliTools.apply'); } }
  };
  window.kiloShowManual = async function () {
    populateAkSelect('kilo');
    var endpoint = getEndpointValue('kilo');
    var apiKey = await getCliApiKey('kilo_ak', 'kilo_akCustom');
    var model = window.__kiloState.model || 'provider/model-id';
    showManualConfigModal([{ filename: '~/.local/share/kilo/auth.json', content: JSON.stringify({ 'openai-compatible': { type: 'api-key', apiKey: apiKey, baseUrl: endpoint, model: model } }, null, 2) }]);
  };
  window.kiloReset = async function () {
    var confirmed = await confirmAction('Reset Kilo Code configuration?', { confirmText: 'Reset', variant: 'danger' });
    if (!confirmed) return;
    try { var res = await api('/cli-tools/kilocode', { method: 'DELETE' }); if (res.ok) { showToolStatus('kilo', 'Configuration reset', 'success'); updateCliBadge('kilo', false); } } catch (e) {}
  };

  // ================================================================
  // CONTINUE — guide config
  // ================================================================
  function renderContinueConfig() {
    var prefix = 'continue';
    var state = window.__continueState || { model: '', apiKey: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;gap:0.5rem;">' +
      '<input type="text" id="continueModel" class="form-control" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(state.model) + '" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="continuePickModel()" type="button" data-i18n="cliTools.selectModel"></button></div></div>';
    html += '<div style="margin-top:1rem;">' +
      '<p style="font-size:0.8rem;color:var(--muted-foreground);margin-bottom:0.5rem;">' + t('cliTools.addModelConfig') + ' <code>~/.continue/config.json</code>:</p>' +
      '<pre class="cli-manual-config-code" id="continueCodeBlock" style="margin-bottom:0.5rem;"></pre>' +
      '<button class="btn btn-outline btn-sm" onclick="continueCopyCode()" type="button"><i class="fa-regular fa-copy"></i> <span data-i18n="cliTools.copyConfig"></span></button></div>';
    html += '</div>';
    return html;
  }
  window.__continueState = { model: '', apiKey: '' };
  window.continuePickModel = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        document.getElementById('continueModel').value = model;
        window.__continueState.model = model;
        updateContinueCode();
        closeDialog('modelPickerModal');
      };
      openModelPicker();
    }
  };
  function updateContinueCode() {
    var endpoint = getEndpointValue('continue');
    var apiKey = document.getElementById('continue_ak') ? document.getElementById('continue_ak').value : '';
    var model = window.__continueState.model || 'provider/model-id';
    var code = document.getElementById('continueCodeBlock');
    if (code) code.textContent = JSON.stringify({
      models: [{ title: 'SuperKiro', provider: 'openai', model: model, apiKey: apiKey, baseUrl: endpoint }],
      tabAutocompleteModel: { title: 'SuperKiro', provider: 'openai', model: model, apiKey: apiKey, baseUrl: endpoint }
    }, null, 2);
  }
  window.continueCopyCode = function () {
    var code = document.getElementById('continueCodeBlock');
    if (code) copyText(code.textContent).then(function () { toast(t('cliTools.copied'), 'primary'); }).catch(function () {});
  };

  // ================================================================
  // ROO — guide config
  // ================================================================
  function renderRooConfig() {
    var prefix = 'roo';
    var state = window.__rooState || { model: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;gap:0.5rem;">' +
      '<input type="text" id="rooModel" class="form-control" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(state.model) + '" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="rooPickModel()" type="button" data-i18n="cliTools.selectModel"></button></div></div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
      '<button class="btn btn-secondary" onclick="rooShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '</div></div>';
    return html;
  }
  window.__rooState = { model: '' };
  window.rooPickModel = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        document.getElementById('rooModel').value = model;
        window.__rooState.model = model;
        closeDialog('modelPickerModal');
      };
      openModelPicker();
    }
  };
  window.rooShowManual = async function () {
    populateAkSelect('roo');
    var endpoint = getEndpointValue('roo');
    var apiKey = await getCliApiKey('roo_ak', 'roo_akCustom');
    var model = window.__rooState.model || 'provider/model-id';
    showManualConfigModal([{
      filename: '~/.roo/config.json',
      content: JSON.stringify({ apiProvider: 'openai', openAiBaseUrl: endpoint, openAiModelId: model, openAiApiKey: apiKey }, null, 2)
    }]);
  };

  // ================================================================
  // DEEPSEEK TUI — dedicated config
  // ================================================================
  function renderDeepSeekConfig() {
    var prefix = 'deepseek';
    var state = window.__deepSeekState || { model: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;gap:0.5rem;">' +
      '<input type="text" id="deepseekModel" class="form-control" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(state.model) + '" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="deepSeekPickModel()" type="button" data-i18n="cliTools.selectModel"></button></div></div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
      '<button class="btn btn-secondary" onclick="deepSeekShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '<button class="btn btn-outline" onclick="deepSeekReset()" type="button" data-i18n="cliTools.reset"></button>' +
      '<button class="btn btn-primary" onclick="deepSeekApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '</div></div>';
    return html;
  }
  window.__deepSeekState = { model: '' };
  window.deepSeekPickModel = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        document.getElementById('deepseekModel').value = model;
        window.__deepSeekState.model = model;
        closeDialog('modelPickerModal');
      };
      openModelPicker();
    }
  };
  window.deepSeekApply = async function () {
    var prefix = 'deepseek';
    populateAkSelect(prefix);
    var endpoint = getEndpointValue(prefix);
    if (!endpoint) { showToolStatus(prefix, 'Please select an endpoint', 'error'); return; }
    var apiKey = await getCliApiKey(prefix + '_ak', prefix + '_akCustom');
    var model = window.__deepSeekState.model || '';
    var applyBtn = document.querySelector('.cli-tool-detail-body .btn-primary');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = t('cliTools.applying'); }
    try {
      var res = await api('/cli-tools/deepseek', { method: 'POST', body: JSON.stringify({ baseUrl: endpoint, apiKey: apiKey || null, model: model }) });
      if (res.ok) { showToolStatus(prefix, t('cliTools.configSuccess'), 'success'); updateCliBadge('deepseek', true); }
      else { var d = await res.json().catch(function () { return {}; }); showToolStatus(prefix, (d && d.error) || t('cliTools.configFailed'), 'error'); }
    } catch (e) { showToolStatus(prefix, e.message || t('cliTools.configFailed'), 'error'); }
    finally { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('cliTools.apply'); } }
  };
  window.deepSeekShowManual = async function () {
    populateAkSelect('deepseek');
    var endpoint = getEndpointValue('deepseek');
    var apiKey = await getCliApiKey('deepseek_ak', 'deepseek_akCustom');
    var model = window.__deepSeekState.model || 'provider/model-id';
    var tomlContent = 'provider = "openai"\n\n[providers.openai]\nbase_url = "' + endpoint + '"\napi_key = "' + (apiKey || 'sk-your-api-key') + '"\nmodel = "' + model + '"\n';
    showManualConfigModal([{ filename: '~/.deepseek/config.toml', content: tomlContent }]);
  };
  window.deepSeekReset = async function () {
    var confirmed = await confirmAction('Reset DeepSeek TUI configuration?', { confirmText: 'Reset', variant: 'danger' });
    if (!confirmed) return;
    try { var res = await api('/cli-tools/deepseek', { method: 'DELETE' }); if (res.ok) { showToolStatus('deepseek', 'Configuration reset', 'success'); updateCliBadge('deepseek', false); } } catch (e) {}
  };

  // ================================================================
  // JCODE — dedicated config
  // ================================================================
  function renderJcodeConfig() {
    var prefix = 'jcode';
    var state = window.__jcodeState || { models: [] };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;flex-wrap:wrap;gap:0.4rem;padding:0.5rem;border:1px solid var(--border);border-radius:6px;margin-bottom:0.5rem;min-height:2rem;">';
    if (state.models.length === 0) html += '<span style="font-size:0.8rem;color:var(--muted-foreground);" data-i18n="cliTools.noModels">No models selected.</span>';
    state.models.forEach(function (m) {
      html += '<span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.15rem 0.5rem;font-size:0.75rem;border-radius:4px;background:var(--muted);color:var(--foreground);border:1px solid var(--border);">' + escapeHtml(m) +
        '<i class="fa-solid fa-xmark" style="cursor:pointer;margin-left:0.2rem;font-size:0.65rem;" onclick="jcodeRemoveModel(\'' + escapeAttr(m) + '\')"></i></span>';
    });
    html += '</div><div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">' +
      '<input type="text" id="jcodeNewModel" class="form-control" style="flex:1;" data-i18n-placeholder="cliTools.typeModelAdd" placeholder="Type model then press Add" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="jcodeAddModel()" type="button" data-i18n="cliTools.addModel">Add Model</button></div></div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
      '<button class="btn btn-secondary" onclick="jcodeShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '<button class="btn btn-outline" onclick="jcodeReset()" type="button" data-i18n="cliTools.reset"></button>' +
      '<button class="btn btn-primary" onclick="jcodeApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '</div></div>';
    return html;
  }
  window.__jcodeState = { models: [] };
  window.jcodeAddModel = function () {
    var inp = document.getElementById('jcodeNewModel');
    if (!inp || !inp.value.trim()) return;
    var s = window.__jcodeState;
    var m = inp.value.trim();
    if (s.models.indexOf(m) === -1) s.models.push(m);
    inp.value = '';
    reRenderDetailBody();
  };
  window.jcodeRemoveModel = function (model) {
    window.__jcodeState.models = window.__jcodeState.models.filter(function (m) { return m !== model; });
    reRenderDetailBody();
  };
  window.jcodeApply = async function () {
    var prefix = 'jcode';
    populateAkSelect(prefix);
    var endpoint = getEndpointValue(prefix);
    if (!endpoint) { showToolStatus(prefix, 'Please select an endpoint', 'error'); return; }
    var apiKey = await getCliApiKey(prefix + '_ak', prefix + '_akCustom');
    var models = window.__jcodeState.models || [];
    var applyBtn = document.querySelector('.cli-tool-detail-body .btn-primary');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = t('cliTools.applying'); }
    try {
      var res = await api('/cli-tools/jcode', { method: 'POST', body: JSON.stringify({ baseUrl: endpoint, apiKey: apiKey || null, models: models }) });
      if (res.ok) { showToolStatus(prefix, t('cliTools.configSuccess'), 'success'); updateCliBadge('jcode', true); }
      else { var d = await res.json().catch(function () { return {}; }); showToolStatus(prefix, (d && d.error) || t('cliTools.configFailed'), 'error'); }
    } catch (e) { showToolStatus(prefix, e.message || t('cliTools.configFailed'), 'error'); }
    finally { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('cliTools.apply'); } }
  };
  window.jcodeShowManual = async function () {
    populateAkSelect('jcode');
    var endpoint = getEndpointValue('jcode');
    var apiKey = await getCliApiKey('jcode_ak', 'jcode_akCustom');
    var models = window.__jcodeState.models.length > 0 ? window.__jcodeState.models : ['provider/model-id'];
    var defaultModel = models[0];
    var modelsToml = models.map(function (m) { return '[[providers.9router.models]]\nid = "' + m + '"'; }).join('\n');
    var tomlContent = '[providers.9router]\ntype = "openai-compatible"\nbase_url = "' + endpoint + '"\nauth = "bearer"\napi_key_env = "JCODE_9ROUTER_API_KEY"\nenv_file = "provider-9router.env"\ndefault_model = "' + defaultModel + '"\nrequires_api_key = true\n' + modelsToml + '\n';
    showManualConfigModal([
      { filename: '~/.jcode/config.toml', content: tomlContent },
      { filename: '~/.config/jcode/provider-9router.env', content: '# jcode provider environment variables\nJCODE_9ROUTER_API_KEY="' + (apiKey || 'sk-your-api-key') + '"\n' }
    ]);
  };
  window.jcodeReset = async function () {
    var confirmed = await confirmAction('Reset jcode configuration?', { confirmText: 'Reset', variant: 'danger' });
    if (!confirmed) return;
    try { var res = await api('/cli-tools/jcode', { method: 'DELETE' }); if (res.ok) { showToolStatus('jcode', 'Configuration reset', 'success'); updateCliBadge('jcode', false); } } catch (e) {}
  };

  // ================================================================
  // HERMES — dedicated config
  // ================================================================
  function renderHermesConfig() {
    var prefix = 'hermes';
    var state = window.__hermesState || { model: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;gap:0.5rem;">' +
      '<input type="text" id="hermesModel" class="form-control" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(state.model) + '" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="hermesPickModel()" type="button" data-i18n="cliTools.selectModel"></button></div></div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
      '<button class="btn btn-secondary" onclick="hermesShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '<button class="btn btn-outline" onclick="hermesReset()" type="button" data-i18n="cliTools.reset"></button>' +
      '<button class="btn btn-primary" onclick="hermesApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '</div></div>';
    return html;
  }
  window.__hermesState = { model: '' };
  window.hermesPickModel = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        document.getElementById('hermesModel').value = model;
        window.__hermesState.model = model;
        closeDialog('modelPickerModal');
      };
      openModelPicker();
    }
  };
  window.hermesApply = async function () {
    var prefix = 'hermes';
    populateAkSelect(prefix);
    var endpoint = getEndpointValue(prefix);
    if (!endpoint) { showToolStatus(prefix, 'Please select an endpoint', 'error'); return; }
    var apiKey = await getCliApiKey(prefix + '_ak', prefix + '_akCustom');
    var model = window.__hermesState.model || '';
    var applyBtn = document.querySelector('.cli-tool-detail-body .btn-primary');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = t('cliTools.applying'); }
    try {
      var res = await api('/cli-tools/hermes', { method: 'POST', body: JSON.stringify({ baseUrl: endpoint, apiKey: apiKey || null, model: model }) });
      if (res.ok) { showToolStatus(prefix, t('cliTools.configSuccess'), 'success'); updateCliBadge('hermes', true); }
      else { var d = await res.json().catch(function () { return {}; }); showToolStatus(prefix, (d && d.error) || t('cliTools.configFailed'), 'error'); }
    } catch (e) { showToolStatus(prefix, e.message || t('cliTools.configFailed'), 'error'); }
    finally { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('cliTools.apply'); } }
  };
  window.hermesShowManual = async function () {
    populateAkSelect('hermes');
    var endpoint = getEndpointValue('hermes');
    var apiKey = await getCliApiKey('hermes_ak', 'hermes_akCustom');
    var model = window.__hermesState.model || 'provider/model-id';
    var yamlContent = 'model:\n  default: "' + model + '"\n  provider: "custom"\n  base_url: "' + endpoint + '"\n';
    showManualConfigModal([
      { filename: '~/.hermes/config.yaml', content: yamlContent },
      { filename: '~/.hermes/.env', content: 'OPENAI_API_KEY=' + (apiKey || 'sk-your-api-key') + '\n' }
    ]);
  };
  window.hermesReset = async function () {
    var confirmed = await confirmAction('Reset Hermes configuration?', { confirmText: 'Reset', variant: 'danger' });
    if (!confirmed) return;
    try { var res = await api('/cli-tools/hermes', { method: 'DELETE' }); if (res.ok) { showToolStatus('hermes', 'Configuration reset', 'success'); updateCliBadge('hermes', false); } } catch (e) {}
  };

  // ================================================================
  // FACTORY DROID — dedicated config
  // ================================================================
  function renderDroidConfig() {
    var prefix = 'droid';
    var state = window.__droidState || { models: [], activeModel: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;flex-wrap:wrap;gap:0.4rem;padding:0.5rem;border:1px solid var(--border);border-radius:6px;margin-bottom:0.5rem;min-height:2rem;">';
    if (state.models.length === 0) html += '<span style="font-size:0.8rem;color:var(--muted-foreground);" data-i18n="cliTools.noModels">No models selected.</span>';
    state.models.forEach(function (m) {
      var isActive = m === state.activeModel;
      html += '<span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.15rem 0.5rem;font-size:0.75rem;border-radius:4px;cursor:pointer;' + (isActive ? 'background:var(--primary);color:#fff;' : 'background:var(--muted);color:var(--foreground);border:1px solid var(--border);') + '" onclick="droidToggleActive(\'' + escapeAttr(m) + '\')">' +
        (isActive ? '<i class="fa-solid fa-star" style="font-size:0.6rem;"></i> ' : '') + escapeHtml(m) +
        '<i class="fa-solid fa-xmark" style="cursor:pointer;margin-left:0.2rem;font-size:0.65rem;" onclick="event.stopPropagation();droidRemoveModel(\'' + escapeAttr(m) + '\')"></i></span>';
    });
    html += '</div><div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">' +
      '<input type="text" id="droidNewModel" class="form-control" style="flex:1;" placeholder="Type model then press Add" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="droidAddModel()" type="button" data-i18n="cliTools.addModel">Add Model</button></div>' +
      '<div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.4rem;">' +
      '<span style="font-size:0.75rem;font-weight:600;color:var(--muted-foreground);min-width:5rem;" data-i18n="cliTools.active">Active:</span>' +
      '<input type="text" class="form-control" style="flex:1;" value="' + escapeAttr(state.activeModel) + '" onchange="window.__droidState.activeModel=this.value" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" /></div></div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
      '<button class="btn btn-secondary" onclick="droidShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '<button class="btn btn-outline" onclick="droidReset()" type="button" data-i18n="cliTools.reset"></button>' +
      '<button class="btn btn-primary" onclick="droidApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '</div></div>';
    return html;
  }
  window.__droidState = { models: [], activeModel: '' };
  window.droidToggleActive = function (model) {
    var s = window.__droidState;
    s.activeModel = s.activeModel === model ? '' : model;
    reRenderDetailBody();
  };
  window.droidRemoveModel = function (model) {
    var s = window.__droidState;
    s.models = s.models.filter(function (m) { return m !== model; });
    if (s.activeModel === model) s.activeModel = s.models.length > 0 ? s.models[0] : '';
    reRenderDetailBody();
  };
  window.droidAddModel = function () {
    var inp = document.getElementById('droidNewModel');
    if (!inp || !inp.value.trim()) return;
    var s = window.__droidState;
    var m = inp.value.trim();
    if (s.models.indexOf(m) === -1) { s.models.push(m); if (!s.activeModel) s.activeModel = m; }
    inp.value = '';
    reRenderDetailBody();
  };
  window.droidApply = async function () {
    var prefix = 'droid';
    populateAkSelect(prefix);
    var endpoint = getEndpointValue(prefix);
    if (!endpoint) { showToolStatus(prefix, 'Please select an endpoint', 'error'); return; }
    var apiKey = await getCliApiKey(prefix + '_ak', prefix + '_akCustom');
    var s = window.__droidState;
    var applyBtn = document.querySelector('.cli-tool-detail-body .btn-primary');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = t('cliTools.applying'); }
    try {
      var res = await api('/cli-tools/droid', { method: 'POST', body: JSON.stringify({ baseUrl: endpoint, apiKey: apiKey || null, models: s.models, activeModel: s.activeModel }) });
      if (res.ok) { showToolStatus(prefix, t('cliTools.configSuccess'), 'success'); updateCliBadge('droid', true); }
      else { var d = await res.json().catch(function () { return {}; }); showToolStatus(prefix, (d && d.error) || t('cliTools.configFailed'), 'error'); }
    } catch (e) { showToolStatus(prefix, e.message || t('cliTools.configFailed'), 'error'); }
    finally { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('cliTools.apply'); } }
  };
  window.droidShowManual = async function () {
    populateAkSelect('droid');
    var endpoint = getEndpointValue('droid');
    var apiKey = await getCliApiKey('droid_ak', 'droid_akCustom');
    var s = window.__droidState;
    var models = s.models.length > 0 ? s.models : ['provider/model-id'];
    var activeModel = s.activeModel || models[0];
    var customModels = models.map(function (m, i) {
      return { model: m, id: 'custom:9Router-' + i, index: m === activeModel ? 0 : i + 1, baseUrl: endpoint, apiKey: apiKey, displayName: m, maxOutputTokens: 131072, noImageSupport: false, provider: 'openai' };
    });
    showManualConfigModal([{ filename: '~/.factory/settings.json', content: JSON.stringify({ customModels: customModels }, null, 2) }]);
  };
  window.droidReset = async function () {
    var confirmed = await confirmAction('Reset Factory Droid configuration?', { confirmText: 'Reset', variant: 'danger' });
    if (!confirmed) return;
    try { var res = await api('/cli-tools/droid', { method: 'DELETE' }); if (res.ok) { showToolStatus('droid', 'Configuration reset', 'success'); updateCliBadge('droid', false); } } catch (e) {}
  };

  // ================================================================
  // OPEN CLAW — dedicated config
  // ================================================================
  function renderOpenClawConfig() {
    var prefix = 'openclaw';
    var state = window.__openClawState || { model: '', agentModels: {} };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;gap:0.5rem;">' +
      '<input type="text" id="openclawModel" class="form-control" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(state.model) + '" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="openClawPickModel()" type="button" data-i18n="cliTools.selectModel"></button></div></div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
      '<button class="btn btn-secondary" onclick="openClawShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '<button class="btn btn-outline" onclick="openClawReset()" type="button" data-i18n="cliTools.reset"></button>' +
      '<button class="btn btn-primary" onclick="openClawApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '</div></div>';
    return html;
  }
  window.__openClawState = { model: '', agentModels: {} };
  window.openClawPickModel = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        document.getElementById('openclawModel').value = model;
        window.__openClawState.model = model;
        closeDialog('modelPickerModal');
      };
      openModelPicker();
    }
  };
  window.openClawApply = async function () {
    var prefix = 'openclaw';
    populateAkSelect(prefix);
    var endpoint = getEndpointValue(prefix);
    if (!endpoint) { showToolStatus(prefix, 'Please select an endpoint', 'error'); return; }
    var apiKey = await getCliApiKey(prefix + '_ak', prefix + '_akCustom');
    var model = window.__openClawState.model || '';
    var applyBtn = document.querySelector('.cli-tool-detail-body .btn-primary');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = t('cliTools.applying'); }
    try {
      var res = await api('/cli-tools/openclaw', { method: 'POST', body: JSON.stringify({ baseUrl: endpoint, apiKey: apiKey || null, model: model, agentModels: {} }) });
      if (res.ok) { showToolStatus(prefix, t('cliTools.configSuccess'), 'success'); updateCliBadge('openclaw', true); }
      else { var d = await res.json().catch(function () { return {}; }); showToolStatus(prefix, (d && d.error) || t('cliTools.configFailed'), 'error'); }
    } catch (e) { showToolStatus(prefix, e.message || t('cliTools.configFailed'), 'error'); }
    finally { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('cliTools.apply'); } }
  };
  window.openClawShowManual = async function () {
    populateAkSelect('openclaw');
    var endpoint = getEndpointValue('openclaw');
    var apiKey = await getCliApiKey('openclaw_ak', 'openclaw_akCustom');
    var model = window.__openClawState.model || 'provider/model-id';
    var ocConfig = {
      agents: { defaults: { model: { primary: '9router/' + model }, models: {} }, list: [{ id: 'default', model: '9router/' + model }] },
      models: { providers: { '9router': { baseUrl: endpoint, apiKey: apiKey, api: 'openai-completions', models: [{ id: model, name: model }] } } }
    };
    ocConfig.agents.defaults.models['9router/' + model] = {};
    showManualConfigModal([{ filename: '~/.openclaw/openclaw.json', content: JSON.stringify(ocConfig, null, 2) }]);
  };
  window.openClawReset = async function () {
    var confirmed = await confirmAction('Reset Open Claw configuration?', { confirmText: 'Reset', variant: 'danger' });
    if (!confirmed) return;
    try { var res = await api('/cli-tools/openclaw', { method: 'DELETE' }); if (res.ok) { showToolStatus('openclaw', 'Configuration reset', 'success'); updateCliBadge('openclaw', false); } } catch (e) {}
  };

  // ================================================================
  // CURSOR — guide config
  // ================================================================
  function renderCursorConfig() {
    var prefix = 'cursor';
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<ol style="margin:0.75rem 0;padding-left:1.25rem;font-size:0.8125rem;line-height:1.6;">' +
      '<li>' + t('cliTools.cursorStep1') + '</li>' +
      '<li>' + t('cliTools.cursorStep2') + '</li>' +
      '<li>' + t('cliTools.cursorStep3') + '</li>' +
      '<li>' + t('cliTools.cursorStep4') + '</li>' +
      '<li>' + t('cliTools.cursorStep5') + '</li>' +
      '</ol>';
    html += '<p style="font-size:0.75rem;color:var(--muted-foreground);margin-top:0.5rem;">' +
      '<i class="fa-solid fa-circle-info"></i> ' + t('cliTools.cursorInfo') + '</p>';
    html += '</div>';
    return html;
  }

  // ================================================================
  // AMP CLI — guide config
  // ================================================================
  function renderAmpConfig() {
    var prefix = 'amp';
    var state = window.__ampState || { model: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;gap:0.5rem;">' +
      '<input type="text" id="ampModel" class="form-control" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(state.model) + '" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="ampPickModel()" type="button" data-i18n="cliTools.selectModel"></button></div></div>';
    html += '<div style="margin-top:0.75rem;">';
    html += '<pre class="cli-manual-config-code" id="ampCodeBlock" style="margin-bottom:0.5rem;"></pre>';
    html += '<button class="btn btn-outline btn-sm" onclick="ampCopyCode()" type="button"><i class="fa-regular fa-copy"></i> <span data-i18n="cliTools.copyConfig"></span></button></div>';
    html += '</div>';
    return html;
  }
  window.__ampState = { model: '' };
  window.ampPickModel = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        document.getElementById('ampModel').value = model;
        window.__ampState.model = model;
        updateAmpCode();
        closeDialog('modelPickerModal');
      };
      openModelPicker();
    }
  };
  function updateAmpCode() {
    var endpoint = getEndpointValue('amp');
    var ak = document.getElementById('amp_ak');
    var apiKey = ak ? ak.value : '';
    var model = window.__ampState.model || 'provider/model-id';
    var code = document.getElementById('ampCodeBlock');
    if (code) code.textContent = 'export OPENAI_API_KEY="' + apiKey + '"\nexport OPENAI_BASE_URL="' + endpoint + '"\namp --model "' + model + '"';
  }
  window.ampCopyCode = function () {
    var code = document.getElementById('ampCodeBlock');
    if (code) copyText(code.textContent).then(function () { toast(t('cliTools.copied'), 'primary'); }).catch(function () {});
  };

  // ================================================================
  // QWEN CODE — guide config
  // ================================================================
  function renderQwenConfig() {
    var prefix = 'qwen';
    var state = window.__qwenState || { model: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;gap:0.5rem;">' +
      '<input type="text" id="qwenModel" class="form-control" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(state.model) + '" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="qwenPickModel()" type="button" data-i18n="cliTools.selectModel"></button></div></div>';
    html += '<div style="margin-top:0.75rem;">';
    html += '<p style="font-size:0.8rem;color:var(--muted-foreground);margin-bottom:0.5rem;">' + t('cliTools.saveTo') + ' <code>~/.qwen/settings.json</code>:</p>';
    html += '<pre class="cli-manual-config-code" id="qwenCodeBlock" style="margin-bottom:0.5rem;"></pre>';
    html += '<button class="btn btn-outline btn-sm" onclick="qwenCopyCode()" type="button"><i class="fa-regular fa-copy"></i> <span data-i18n="cliTools.copyConfig"></span></button></div>';
    html += '</div>';
    return html;
  }
  window.__qwenState = { model: '' };
  window.qwenPickModel = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        document.getElementById('qwenModel').value = model;
        window.__qwenState.model = model;
        updateQwenCode();
        closeDialog('modelPickerModal');
      };
      openModelPicker();
    }
  };
  function updateQwenCode() {
    var endpoint = getEndpointValue('qwen');
    var ak = document.getElementById('qwen_ak');
    var apiKey = ak ? ak.value : '';
    var model = window.__qwenState.model || 'provider/model-id';
    var code = document.getElementById('qwenCodeBlock');
    if (code) code.textContent = JSON.stringify({
      security: { auth: { selectedType: 'openai', apiKey: apiKey, baseUrl: endpoint } },
      model: { name: model }
    }, null, 2);
  }
  window.qwenCopyCode = function () {
    var code = document.getElementById('qwenCodeBlock');
    if (code) copyText(code.textContent).then(function () { toast(t('cliTools.copied'), 'primary'); }).catch(function () {});
  };

  // ================================================================
  // CLAUDE COWORK — guide config (MCP plugins not yet supported)
  // ================================================================
  function renderCoworkConfig() {
    var prefix = 'cowork';
    var state = window.__coworkState || { model: '' };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;gap:0.5rem;">' +
      '<input type="text" id="coworkModel" class="form-control" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(state.model) + '" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="coworkPickModel()" type="button" data-i18n="cliTools.selectModel"></button></div></div>';
    html += '<p style="font-size:0.8rem;color:var(--muted-foreground);margin:0.75rem 0 0;">' + t('cliTools.mcpComingSoon') + '</p>';
    html += '</div>';
    return html;
  }
  window.__coworkState = { model: '' };
  window.coworkPickModel = function () {
    if (typeof openModelPicker === 'function') {
      window.__cliModelCallback = function (model) {
        document.getElementById('coworkModel').value = model;
        window.__coworkState.model = model;
        closeDialog('modelPickerModal');
      };
      openModelPicker();
    }
  };

  // ================================================================
  // MITM SERVER — infrastructure management
  // ================================================================
  function renderMitmServerConfig() {
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += '<div class="form-group"><label data-i18n="cliTools.apiKey">API Key</label>' +
      '<select id="mitm_ak" class="form-control" data-native-select="true">' +
      '<option value="">--</option><option value="custom" data-i18n="cliTools.customUrl"></option></select>' +
      '<input type="text" id="mitm_akCustom" class="form-control hidden" style="margin-top:0.4rem;" data-i18n-placeholder="cliTools.apiKeyPlaceholder" placeholder="sk-..." autocomplete="off" /></div>';
    html += '<div class="form-group"><label data-i18n="cliTools.sudoPassword">sudo password (for DNS + cert)</label>' +
      '<input type="password" id="mitmSudoPass" class="form-control" data-i18n-placeholder="cliTools.sudoPlaceholder" placeholder="sudo password" autocomplete="off" /></div>';
    html += '<div id="mitm_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap;">' +
      '<button class="btn btn-primary" onclick="mitmStart()" type="button" data-i18n="cliTools.startServer">Start Server</button>' +
      '<button class="btn btn-outline" onclick="mitmStop()" type="button" data-i18n="cliTools.stopServer">Stop Server</button>' +
      '<button class="btn btn-secondary" onclick="mitmRefreshStatus()" type="button" data-i18n="cliTools.refreshStatus">Refresh Status</button>' +
      '</div>';
    html += '<div id="mitmDnsStatus" style="margin-top:0.75rem;font-size:0.8125rem;"></div>';
    html += '</div>';
    return html;
  }
  window.mitmStart = async function () {
    var ak = document.getElementById('mitm_ak');
    var apiKey = '';
    if (ak && ak.value === 'custom') {
      var c = document.getElementById('mitm_akCustom');
      apiKey = c ? c.value.trim() : '';
    } else if (ak && ak.value) {
      apiKey = await getCliApiKey('mitm_ak', 'mitm_akCustom');
    }
    var sudoPass = document.getElementById('mitmSudoPass') ? document.getElementById('mitmSudoPass').value : '';
    if (!apiKey) { showToolStatus('mitm', 'API Key required', 'error'); return; }
    try {
      var res = await api('/cli-tools/mitm/server', { method: 'POST', body: JSON.stringify({ apiKey: apiKey, sudoPassword: sudoPass }) });
      if (res.ok) { showToolStatus('mitm', 'MITM server started', 'success'); mitmRefreshStatus(); }
      else { var d = await res.json().catch(function(){}); showToolStatus('mitm', (d&&d.error)||'Failed to start', 'error'); }
    } catch(e) { showToolStatus('mitm', e.message, 'error'); }
  };
  window.mitmStop = async function () {
    try {
      var res = await api('/cli-tools/mitm/server', { method: 'DELETE' });
      if (res.ok) { showToolStatus('mitm', 'MITM server stopped', 'success'); mitmRefreshStatus(); }
    } catch(e) { showToolStatus('mitm', e.message, 'error'); }
  };
  window.mitmRefreshStatus = async function () {
    try {
      var res = await api('/cli-tools/mitm/status');
      if (res.ok) {
        var d = await res.json();
        var el = document.getElementById('mitmDnsStatus');
        if (el) {
          var html = '<strong>Server:</strong> ' + (d.running ? '<span style="color:#16a34a;">Running</span>' : '<span style="color:#dc2626;">Stopped</span>');
          html += '<br><strong>DNS:</strong> ';
          var tools = { antigravity: 'Antigravity', copilot: 'Copilot', kiro: 'Kiro' };
          for (var t in tools) {
            html += '<span style="margin-right:0.5rem;">' + tools[t] + ': ' + (d.dns && d.dns[t] ? '<span style="color:#16a34a;">ON</span>' : '<span style="color:#dc2626;">OFF</span>') + '</span>';
          }
          el.innerHTML = html;
        }
      }
    } catch(e) {}
  };

  // ================================================================
  // ANTIGRAVITY — MITM tool with model aliases
  // ================================================================
  function renderAntigravityConfig() {
    var prefix = 'antigravity';
    var state = window.__antigravityState || { models: {} };
    var aliasKeys = ['gemini-2.5-flash','gemini-2.5-pro','gemini-2.0-flash','gemini-2.0-flash-lite','gemini-1.5-flash','gemini-1.5-pro','gemini-2.5-flash-preview','gemini-2.5-pro-preview','gemini-2.0-flash-preview'];
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += '<div class="form-group"><label data-i18n="cliTools.apiKey">API Key</label>' +
      '<select id="antigravity_ak" class="form-control" data-native-select="true">' +
      '<option value="">--</option><option value="custom" data-i18n="cliTools.customUrl"></option></select>' +
      '<input type="text" id="antigravity_akCustom" class="form-control hidden" style="margin-top:0.4rem;" data-i18n-placeholder="cliTools.apiKeyPlaceholder" placeholder="sk-..." autocomplete="off" /></div>';
    html += '<div class="form-group"><label data-i18n="cliTools.modelMappings">Model Mappings</label>';
    aliasKeys.forEach(function (k, idx) {
      var val = state.models[k] || '';
      html += '<div style="display:flex;gap:0.5rem;align-items:center;margin-top:' + (idx > 0 ? '0.35rem' : '0.35rem') + ';">' +
        '<span style="font-size:0.75rem;font-weight:600;color:var(--muted-foreground);min-width:7rem;">' + escapeHtml(k) + '</span>' +
        '<input type="text" class="form-control ag-alias-input" style="flex:1;" data-i18n-placeholder="cliTools.modelPlaceholder" placeholder="provider/model-id" value="' + escapeAttr(val) + '" autocomplete="off" data-alias="' + escapeAttr(k) + '" />' +
        (val ? '<button class="btn btn-outline btn-sm ag-alias-clear" type="button" data-alias="' + escapeAttr(k) + '" style="padding:0.25rem 0.5rem;" title="Clear">&times;</button>' : '') +
        '<button class="btn btn-outline btn-sm ag-alias-select" type="button" data-alias="' + escapeAttr(k) + '" data-i18n="cliTools.selectModel"></button>' +
        '</div>';
    });
    html += '</div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap;">' +
      '<button class="btn btn-primary" onclick="antigravityApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '<button class="btn btn-secondary" onclick="antigravityShowManual()" type="button" data-i18n="cliTools.manualConfig"></button>' +
      '<button class="btn btn-outline" onclick="antigravityToggleDns()" type="button" data-i18n="cliTools.toggleDns">Toggle DNS</button>' +
      '</div></div>';
    return html;
  }
  window.__antigravityState = { models: {} };
  window.antigravityApply = async function () {
    var prefix = 'antigravity';
    var s = window.__antigravityState;
    document.querySelectorAll('.ag-alias-input').forEach(function (inp) {
      s.models[inp.dataset.alias] = inp.value;
    });
    try {
      var res = await api('/cli-tools/mitm/aliases', { method: 'PUT', body: JSON.stringify({ tool: 'antigravity', mappings: s.models }) });
      if (res.ok) { showToolStatus(prefix, 'Aliases saved', 'success'); updateCliBadge('antigravity', true); }
      else { showToolStatus(prefix, 'Failed to save', 'error'); }
    } catch(e) { showToolStatus(prefix, e.message, 'error'); }
  };
  window.antigravityShowManual = function () {
    var s = window.__antigravityState;
    showManualConfigModal([{ filename: t('cliTools.modelMappings'), content: JSON.stringify(s.models, null, 2) }]);
  };
  window.antigravityToggleDns = async function () {
    var el = document.getElementById('antigravity_status');
    if (el) { el.className = 'cli-tool-status-success'; el.textContent = 'Toggling DNS...'; el.classList.remove('hidden'); }
    try {
      var statusRes = await api('/cli-tools/mitm/status');
      var dnsOn = false;
      if (statusRes.ok) { var st = await statusRes.json(); dnsOn = st.dns && st.dns.antigravity; }
      var res = await api('/cli-tools/mitm/dns', { method: 'PATCH', body: JSON.stringify({ tool: 'antigravity', action: dnsOn ? 'disable' : 'enable', sudoPassword: '' }) });
      if (res.ok) { showToolStatus('antigravity', 'DNS ' + (dnsOn ? 'disabled' : 'enabled'), 'success'); }
    } catch(e) { showToolStatus('antigravity', e.message, 'error'); }
  };

  // ================================================================
  // COPILOT — MITM tool with endpoint + API key + models
  // ================================================================
  function renderCopilotConfig() {
    var prefix = 'copilot';
    var state = window.__copilotState || { models: [] };
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += renderEndpointApiKeyFields(prefix);
    html += '<div class="form-group"><label data-i18n="cliTools.model"></label>' +
      '<div style="display:flex;flex-wrap:wrap;gap:0.4rem;padding:0.5rem;border:1px solid var(--border);border-radius:6px;margin-bottom:0.5rem;min-height:2rem;">';
    if (state.models.length === 0) html += '<span style="font-size:0.8rem;color:var(--muted-foreground);" data-i18n="cliTools.noModels">No models selected.</span>';
    state.models.forEach(function (m) {
      html += '<span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.15rem 0.5rem;font-size:0.75rem;border-radius:4px;background:var(--muted);color:var(--foreground);border:1px solid var(--border);">' + escapeHtml(m) +
        '<i class="fa-solid fa-xmark" style="cursor:pointer;margin-left:0.2rem;font-size:0.65rem;" onclick="copilotRemoveModel(\'' + escapeAttr(m) + '\')"></i></span>';
    });
    html += '</div><div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">' +
      '<input type="text" id="copilotNewModel" class="form-control" style="flex:1;" placeholder="Type model then press Add" autocomplete="off" />' +
      '<button class="btn btn-outline btn-sm" onclick="copilotAddModel()" type="button" data-i18n="cliTools.addModel">Add Model</button>' +
      '<button class="btn btn-outline btn-sm" onclick="copilotSelectModel()" type="button" data-i18n="cliTools.selectModel">Select Model</button></div></div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap;">' +
      '<button class="btn btn-primary" onclick="copilotApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '<button class="btn btn-outline" onclick="copilotReset()" type="button" data-i18n="cliTools.reset"></button>' +
      '<button class="btn btn-secondary" onclick="copilotToggleDns()" type="button" data-i18n="cliTools.toggleDns">Toggle DNS</button>' +
      '</div></div>';
    return html;
  }
  window.__copilotState = { models: [] };
  window.copilotAddModel = function () {
    var inp = document.getElementById('copilotNewModel');
    if (!inp || !inp.value.trim()) return;
    var s = window.__copilotState;
    var m = inp.value.trim();
    if (s.models.indexOf(m) === -1) s.models.push(m);
    inp.value = '';
    reRenderDetailBody();
  };
  window.copilotRemoveModel = function (model) {
    window.__copilotState.models = window.__copilotState.models.filter(function (m) { return m !== model; });
    reRenderDetailBody();
  };
  window.copilotSelectModel = function () {
    window.__cliModelCallback = function (model) {
      var s = window.__copilotState;
      if (s.models.indexOf(model) === -1) { s.models.push(model); }
      reRenderDetailBody();
      closeDialog('modelPickerModal');
    };
    openModelPicker();
  };
  window.copilotApply = async function () {
    var prefix = 'copilot';
    populateAkSelect(prefix);
    var endpoint = getEndpointValue(prefix);
    if (!endpoint) { showToolStatus(prefix, 'Please select an endpoint', 'error'); return; }
    var apiKey = await getCliApiKey(prefix + '_ak', prefix + '_akCustom');
    var models = window.__copilotState.models || [];
    var applyBtn = document.querySelector('.cli-tool-detail-body .btn-primary');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = t('cliTools.applying'); }
    try {
      var res = await api('/cli-tools/copilot-settings', { method: 'POST', body: JSON.stringify({ baseUrl: endpoint, apiKey: apiKey || null, models: models }) });
      if (res.ok) { showToolStatus(prefix, t('cliTools.configSuccess'), 'success'); updateCliBadge('copilot', true); }
      else { var d = await res.json().catch(function(){}); showToolStatus(prefix, (d&&d.error)||t('cliTools.configFailed'), 'error'); }
    } catch(e) { showToolStatus(prefix, e.message||t('cliTools.configFailed'), 'error'); }
    finally { if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('cliTools.apply'); } }
  };
  window.copilotReset = async function () {
    var confirmed = await confirmAction('Reset Copilot configuration?', { confirmText: 'Reset', variant: 'danger' });
    if (!confirmed) return;
    try { var res = await api('/cli-tools/copilot-settings', { method: 'DELETE' }); if (res.ok) { showToolStatus('copilot', 'Configuration reset', 'success'); updateCliBadge('copilot', false); } } catch(e) {}
  };
  window.copilotToggleDns = async function () {
    try {
      var statusRes = await api('/cli-tools/mitm/status');
      var dnsOn = false;
      if (statusRes.ok) { var st = await statusRes.json(); dnsOn = st.dns && st.dns.copilot; }
      var res = await api('/cli-tools/mitm/dns', { method: 'PATCH', body: JSON.stringify({ tool: 'copilot', action: dnsOn ? 'disable' : 'enable', sudoPassword: '' }) });
      if (res.ok) { showToolStatus('copilot', 'DNS ' + (dnsOn ? 'disabled' : 'enabled'), 'success'); }
    } catch(e) { showToolStatus('copilot', e.message, 'error'); }
  };

  // ================================================================
  // KIRO — MITM tool with model mappings
  // ================================================================
  function renderKiroConfig() {
    var prefix = 'kiro';
    var state = window.__kiroState || { models: {} };
    var mappingKeys = Object.keys(state.models);
    var html = '<div style="padding:1rem;border-top:1px solid var(--border);">';
    html += '<div class="form-group"><label data-i18n="cliTools.modelMappings">Model Mappings</label>' +
      '<div style="font-size:0.75rem;color:var(--muted-foreground);margin-bottom:0.5rem;">' + t('cliTools.mappingDesc') + '</div>';
    html += '<div id="kiroMappings">';
    if (mappingKeys.length === 0) {
      html += '<span style="font-size:0.8rem;color:var(--muted-foreground);" data-i18n="cliTools.noMappings">No mappings yet. Add one below.</span>';
    } else {
      mappingKeys.forEach(function (k, idx) {
        html += '<div style="display:flex;gap:0.5rem;align-items:center;margin-top:' + (idx > 0 ? '0.35rem' : '0') + ';" class="kiro-mapping-row">' +
          '<input type="text" class="form-control kiro-from" style="flex:1;" data-i18n-placeholder="cliTools.cwModelPlaceholder" placeholder="CodeWhisperer model ID" value="' + escapeAttr(k) + '" autocomplete="off" />' +
          '<span style="font-size:0.75rem;color:var(--muted-foreground);">&rarr;</span>' +
          '<input type="text" class="form-control kiro-to" style="flex:1;" data-i18n-placeholder="cliTools.skModelPlaceholder" placeholder="SuperKiro model" value="' + escapeAttr(state.models[k]) + '" autocomplete="off" />' +
          '<button class="btn btn-outline btn-sm" onclick="kiroSelectModel(this)" type="button" data-i18n="cliTools.selectModel">Select</button>' +
          '<button class="btn btn-outline btn-sm" onclick="kiroRemoveMapping(this)" type="button" style="padding:0.25rem 0.5rem;">&times;</button>' +
          '</div>';
      });
    }
    html += '</div>';
    html += '<div style="display:flex;gap:0.5rem;margin-top:0.5rem;">' +
      '<button class="btn btn-outline btn-sm" onclick="kiroAddMapping()" type="button" data-i18n="cliTools.addMapping">+ Add Mapping</button></div></div>';
    html += '<div id="' + prefix + '_status" class="hidden" style="margin-top:0.75rem;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.8125rem;"></div>';
    html += '<div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap;">' +
      '<button class="btn btn-primary" onclick="kiroApply()" type="button" data-i18n="cliTools.apply"></button>' +
      '<button class="btn btn-secondary" onclick="kiroToggleDns()" type="button" data-i18n="cliTools.toggleDns">Toggle DNS</button>' +
      '</div></div>';
    return html;
  }
  window.__kiroState = { models: {} };
  window.kiroAddMapping = function () {
    var container = document.getElementById('kiroMappings');
    if (!container) return;
    var empty = container.querySelector('.kiro-mapping-row');
    if (!empty || empty.querySelector('.kiro-from').value !== '' || empty.querySelector('.kiro-to').value !== '') {
      var div = document.createElement('div');
      div.className = 'kiro-mapping-row';
      div.style.cssText = 'display:flex;gap:0.5rem;align-items:center;margin-top:0.35rem;';
      div.innerHTML = '<input type="text" class="form-control kiro-from" style="flex:1;" data-i18n-placeholder="cliTools.cwModelPlaceholder" placeholder="CodeWhisperer model ID" autocomplete="off" />' +
        '<span style="font-size:0.75rem;color:var(--muted-foreground);">&rarr;</span>' +
        '<input type="text" class="form-control kiro-to" style="flex:1;" data-i18n-placeholder="cliTools.skModelPlaceholder" placeholder="SuperKiro model" autocomplete="off" />' +
        '<button class="btn btn-outline btn-sm" onclick="kiroSelectModel(this)" type="button" data-i18n="cliTools.selectModel">Select</button>' +
        '<button class="btn btn-outline btn-sm" onclick="kiroRemoveMapping(this)" type="button" style="padding:0.25rem 0.5rem;">&times;</button>';
      container.appendChild(div);
    }
  };
  window.kiroRemoveMapping = function (btn) {
    var row = btn.closest('.kiro-mapping-row');
    if (row) row.remove();
  };
  window.kiroSelectModel = function (btn) {
    var row = btn.closest('.kiro-mapping-row');
    window.__cliModelCallback = function (model) {
      if (row) {
        var to = row.querySelector('.kiro-to');
        if (to) to.value = model;
      }
      closeDialog('modelPickerModal');
    };
    openModelPicker();
  };
  window.kiroApply = async function () {
    var prefix = 'kiro';
    var mappings = {};
    document.querySelectorAll('.kiro-mapping-row').forEach(function (row) {
      var from = row.querySelector('.kiro-from');
      var to = row.querySelector('.kiro-to');
      if (from && to && from.value.trim() && to.value.trim()) {
        mappings[from.value.trim()] = to.value.trim();
      }
    });
    window.__kiroState.models = mappings;
    try {
      var res = await api('/cli-tools/mitm/aliases', { method: 'PUT', body: JSON.stringify({ tool: 'kiro', mappings: mappings }) });
      if (res.ok) { showToolStatus(prefix, 'Mappings saved', 'success'); updateCliBadge('kiro', true); }
      else { showToolStatus(prefix, 'Failed to save', 'error'); }
    } catch(e) { showToolStatus(prefix, e.message, 'error'); }
  };
  window.kiroToggleDns = async function () {
    try {
      var statusRes = await api('/cli-tools/mitm/status');
      var dnsOn = false;
      if (statusRes.ok) { var st = await statusRes.json(); dnsOn = st.dns && st.dns.kiro; }
      var res = await api('/cli-tools/mitm/dns', { method: 'PATCH', body: JSON.stringify({ tool: 'kiro', action: dnsOn ? 'disable' : 'enable', sudoPassword: '' }) });
      if (res.ok) { showToolStatus('kiro', 'DNS ' + (dnsOn ? 'disabled' : 'enabled'), 'success'); }
    } catch(e) { showToolStatus('kiro', e.message, 'error'); }
  };

  // ================================================================
  // CLI TOOLS — Grid + Detail view
  // ================================================================
  var CLI_TOOL_META = [
    { id: 'claude', nameKey: 'cliTools.toolClaude', descKey: 'cliTools.descClaude', icon: 'claude.png', render: renderClaudeConfig },
    { id: 'opencode', nameKey: 'cliTools.toolOpenCode', descKey: 'cliTools.descOpenCode', icon: 'opencode.png', render: renderOpenCodeConfig },
    { id: 'cline', nameKey: 'cliTools.toolCline', descKey: 'cliTools.descCline', icon: 'cline.png', render: renderClineConfig },
    { id: 'codex', nameKey: 'cliTools.toolCodex', descKey: 'cliTools.descCodex', icon: 'codex.png', render: renderCodexConfig },
    { id: 'kilo', nameKey: 'cliTools.toolKiloCode', descKey: 'cliTools.descKiloCode', icon: 'kilocode.png', render: renderKiloConfig },
    { id: 'continue', nameKey: 'cliTools.toolContinue', descKey: 'cliTools.descContinue', icon: 'continue.png', render: renderContinueConfig },
    { id: 'roo', nameKey: 'cliTools.toolRoo', descKey: 'cliTools.descRoo', icon: 'roo.png', render: renderRooConfig },
    { id: 'deepseek', nameKey: 'cliTools.toolDeepSeek', descKey: 'cliTools.descDeepSeek', icon: 'deepseek.png', render: renderDeepSeekConfig },
    { id: 'jcode', nameKey: 'cliTools.toolJcode', descKey: 'cliTools.descJcode', icon: 'jcode.png', render: renderJcodeConfig },
    { id: 'hermes', nameKey: 'cliTools.toolHermes', descKey: 'cliTools.descHermes', icon: 'hermes.png', render: renderHermesConfig },
    { id: 'droid', nameKey: 'cliTools.toolDroid', descKey: 'cliTools.descDroid', icon: 'droid.png', render: renderDroidConfig },
    { id: 'openclaw', nameKey: 'cliTools.toolOpenClaw', descKey: 'cliTools.descOpenClaw', icon: 'openclaw.png', render: renderOpenClawConfig },
    { id: 'cursor', nameKey: 'cliTools.toolCursor', descKey: 'cliTools.descCursor', icon: 'cursor.png', render: renderCursorConfig },
    { id: 'amp', nameKey: 'cliTools.toolAmp', descKey: 'cliTools.descAmp', icon: 'amp.png', render: renderAmpConfig },
    { id: 'qwen', nameKey: 'cliTools.toolQwen', descKey: 'cliTools.descQwen', icon: 'qwen.png', render: renderQwenConfig },
    { id: 'cowork', nameKey: 'cliTools.toolCowork', descKey: 'cliTools.descCowork', icon: 'fa-people-arrows', render: renderCoworkConfig },
    // MITM tools
    { id: 'mitm', nameKey: 'cliTools.toolMitmServer', descKey: 'cliTools.descMitmServer', icon: 'fa-server', render: renderMitmServerConfig },
    { id: 'antigravity', nameKey: 'cliTools.toolAntigravity', descKey: 'cliTools.descAntigravity', icon: 'antigravity.png', render: renderAntigravityConfig },
    { id: 'copilot', nameKey: 'cliTools.toolCopilot', descKey: 'cliTools.descCopilot', icon: 'copilot.png', render: renderCopilotConfig },
    { id: 'kiro', nameKey: 'cliTools.toolKiro', descKey: 'cliTools.descKiro', icon: 'kiro.png', render: renderKiroConfig }
  ];

  var cliToolStatuses = {};

  function getCliToolStatus(toolId) {
    var s = cliToolStatuses[toolId];
    if (!s) return 'unknown';
    if (!s.installed) return 'not_installed';
    if (!s.hasSuperKiro) return 'not_configured';
    return 'connected';
  }

  async function loadCliToolStatus() {
    CLI_TOOL_META.forEach(function(m) { delete cliToolStatuses[m.id]; });
    var grid = $('cliToolsGrid');
    if (grid) renderCliToolGrid(grid);
    try {
      var res = await api('/cli-tools/status');
      var data = await res.json();
      for (var k in data) {
        if (data.hasOwnProperty(k)) {
          cliToolStatuses[k] = { installed: !!data[k].installed, hasSuperKiro: !!data[k].hasSuperKiro };
        }
      }
    } catch (e) {}
    if (grid) renderCliToolGrid(grid);
  }

  function updateCliBadge(toolId, connected) {
    var existing = cliToolStatuses[toolId] || { installed: true };
    existing.hasSuperKiro = connected;
    cliToolStatuses[toolId] = existing;
    var card = document.querySelector('.cli-tool-card[data-cli-tool="' + toolId + '"]');
    if (!card) return;
    var badge = card.querySelector('.cli-tool-status');
    if (badge) {
      var status = getCliToolStatus(toolId);
      badge.className = 'cli-tool-status ' + (status === 'connected' ? 'cli-tool-status-connected' : 'cli-tool-status-notconfigured');
      badge.textContent = t(status === 'connected' ? 'cliTools.connected' : 'cliTools.notConfigured');
    }
  }

  function renderCliTools() {
    var grid = $('cliToolsGrid');
    var detail = $('cliToolDetail');
    if (!grid || !detail) return;

    if (cliToolDetailId) {
      grid.style.display = 'none';
      detail.classList.remove('hidden');
      renderCliToolDetail(detail, cliToolDetailId);
    } else {
      grid.style.display = '';
      detail.classList.add('hidden');
      renderCliToolGrid(grid);
    }
  }

  function renderToolIcon(icon) {
    if (icon.startsWith('fa-')) return '<i class="fa-solid ' + icon + '"></i>';
    return '<img src="/admin/clitools/' + icon + '" alt="" style="width:1.25rem;height:1.25rem;object-fit:contain;">';
  }

  function renderCliToolGrid(grid) {
    grid.innerHTML = '';
    CLI_TOOL_META.forEach(function (meta) {
      var card = document.createElement('div');
      card.className = 'cli-tool-card';
      card.dataset.cliTool = meta.id;
      var status = getCliToolStatus(meta.id);
      var statusClass, statusLabel;
      switch (status) {
        case 'connected': statusClass = 'cli-tool-status-connected'; statusLabel = t('cliTools.connected'); break;
        case 'not_configured': statusClass = 'cli-tool-status-notconfigured'; statusLabel = t('cliTools.notConfigured'); break;
        case 'not_installed': statusClass = 'cli-tool-status-notinstalled'; statusLabel = t('cliTools.notInstalled'); break;
        default: statusClass = 'cli-tool-status-unknown'; statusLabel = t('cliTools.unknown');
      }
      card.innerHTML =
        '<span class="cli-tool-icon">' + renderToolIcon(meta.icon) + '</span>' +
        '<div class="cli-tool-info">' +
        '<div class="cli-tool-name" data-i18n="' + meta.nameKey + '"></div>' +
        '<div class="cli-tool-desc" data-i18n="' + meta.descKey + '"></div>' +
        '</div>' +
        '<span class="cli-tool-status ' + statusClass + '">' + statusLabel + '</span>';
      card.addEventListener('click', function () {
        if (getCliToolStatus(meta.id) === 'not_installed') {
          toast(t('cliTools.notInstalled') + ': ' + t(meta.nameKey), 'info');
          return;
        }
        cliToolDetailId = meta.id;
        renderCliTools();
      });
      grid.appendChild(card);
    });
    applyTranslations();
  }

  async function renderCliToolDetail(detail, toolId) {
    var meta = CLI_TOOL_META.find(function (m) { return m.id === toolId; });
    if (!meta) { cliToolDetailId = null; renderCliTools(); return; }

    detail.innerHTML =
      '<div class="cli-tool-detail-back" onclick="window.backToCliTools()">' +
      '<i class="fa-solid fa-arrow-left"></i> ' + escapeHtml(t('common.back')) +
      '</div>' +
      '<div class="cli-tool-detail-header" style="display:flex;align-items:center;gap:0.75rem;">' +
      '<span class="cli-tool-icon">' + renderToolIcon(meta.icon) + '</span>' +
      '<div><h2>' + escapeHtml(t(meta.nameKey)) + '</h2>' +
      '<p class="cli-tool-detail-desc">' + escapeHtml(t(meta.descKey)) + '</p></div>' +
      '</div>' +
      '<div class="cli-tool-detail-body">' +
      meta.render() +
      '</div>';

    applyTranslations();

    if (toolId === 'claude') bindClaudeEvents();
    else if (toolId === 'opencode') bindOcEvents();
    else if (toolId === 'cline') bindClineEvents();
    else if (toolId === 'codex') bindCodexEvents();
    else if (toolId === 'kilo') bindKiloEvents();
    else if (toolId === 'continue') bindContinueEvents();
    else if (toolId === 'roo') bindRooEvents();
    else if (toolId === 'deepseek') bindDeepSeekEvents();
    else if (toolId === 'jcode') bindJcodeEvents();
    else if (toolId === 'hermes') bindHermesEvents();
    else if (toolId === 'droid') bindDroidEvents();
    else if (toolId === 'openclaw') bindOpenClawEvents();
    else if (toolId === 'cursor') bindCursorEvents();
    else if (toolId === 'amp') bindAmpEvents();
    else if (toolId === 'qwen') bindQwenEvents();
    else if (toolId === 'cowork') bindCoworkEvents();
    else if (toolId === 'mitm') bindMitmEvents();
    else if (toolId === 'antigravity') bindAntigravityEvents();
    else if (toolId === 'copilot') bindCopilotEvents();
    else if (toolId === 'kiro') bindKiroEvents();

    populateAkSelect(toolId);
    if (apiKeysCache.length === 0) { await loadApiKeys(); populateAkSelect(toolId); }
    loadCliToolSettings(toolId);
  }

  function populateEndpointField(prefix, baseUrl) {
    if (!baseUrl) return;
    var ep = $(prefix + '_ep');
    if (!ep) return;
    var localUrl = ep.options[0].textContent;
    var norm = function(u) { return u.replace(/\/+$/, '').replace(/\/v1$/, ''); };
    if (norm(baseUrl) === norm(localUrl)) {
      ep.value = 'local';
    } else {
      ep.value = 'custom';
      var c = $(prefix + '_epCustom');
      if (c) { c.value = baseUrl; c.classList.remove('hidden'); }
    }
  }

  function populateApiKeyField(prefix, apiKey) {
    if (!apiKey) return;
    var ak = $(prefix + '_ak');
    if (!ak) return;
    ak.value = 'custom';
    var c = $(prefix + '_akCustom');
    if (c) { c.value = apiKey; c.classList.remove('hidden'); }
  }

  async function loadCliToolSettings(toolId) {
    var res = await api('/cli-tools/' + toolId);
    if (!res.ok) return;
    var s = await res.json();
    if (!s || s.error) return;

    var prefix = toolId;
    var needsReRender = false;

    switch (toolId) {
      case 'claude':
        if (s.env) {
          if (!window.claudeSlotState) window.claudeSlotState = {};
          ['opus','sonnet','haiku'].forEach(function(k) {
            var envKey = 'ANTHROPIC_DEFAULT_' + k.toUpperCase() + '_MODEL';
            if (s.env[envKey]) {
              window.claudeSlotState[k] = s.env[envKey];
              var inp = document.querySelector('.claude-slot-input[data-slot="' + k + '"]');
              if (inp) inp.value = s.env[envKey];
            }
          });
        }
        break;
      case 'opencode':
        if (s.models || s.activeModel || s.subagentModel) {
          var st = window.__openCodeState || { models: [], activeModel: '', subagentModel: '' };
          if (s.models) st.models = s.models;
          if (s.activeModel) st.activeModel = s.activeModel;
          if (s.subagentModel) st.subagentModel = s.subagentModel;
          window.__openCodeState = st;
          needsReRender = true;
        }
        break;
      case 'copilot':
        if (s.models) {
          var cps = window.__copilotState || { models: [] };
          cps.models = s.models;
          window.__copilotState = cps;
          needsReRender = true;
        }
        break;
      case 'codex':
        if (s.model) {
          var cs = window.__codexState || {};
          cs.model = s.model;
          if (s.subagentModel) cs.subagentModel = s.subagentModel;
          window.__codexState = cs;
          needsReRender = true;
        }
        break;
      case 'cline':
        if (s.model) {
          if (!window.__clineState) window.__clineState = { model: '' };
          window.__clineState.model = s.model;
          var inp = document.getElementById('clineModel');
          if (inp) inp.value = s.model;
        }
        break;
      case 'deepseek':
        if (s.model) {
          var inp = document.getElementById('deepseekModel');
          if (inp) inp.value = s.model;
        }
        break;
      case 'kilo':
        if (s.model) {
          var inp = document.getElementById('kiloModel');
          if (inp) inp.value = s.model;
        }
        break;
      case 'hermes':
        if (s.model) {
          var inp = document.getElementById('hermesModel');
          if (inp) inp.value = s.model;
        }
        break;
      case 'jcode':
        if (s.models) {
          if (!window.__jcodeState) window.__jcodeState = { models: [] };
          window.__jcodeState.models = s.models;
          needsReRender = true;
        }
        break;
      case 'droid':
        if (s.models || s.activeModel) {
          if (!window.__droidState) window.__droidState = { models: [], activeModel: '', subagentModel: '' };
          if (s.models) window.__droidState.models = s.models;
          if (s.activeModel) window.__droidState.activeModel = s.activeModel;
          needsReRender = true;
        }
        break;
      case 'openclaw':
        if (s.model || s.agentModels) {
          if (!window.__openclawState) window.__openclawState = { model: '', agentModels: {} };
          if (s.model) window.__openclawState.model = s.model;
          if (s.agentModels) window.__openclawState.agentModels = s.agentModels;
          needsReRender = true;
        }
        break;
    }

    if (s.config) {
      if (toolId === 'codex') {
        var modelMatch = s.config.match(/^model\s*=\s*"([^"]+)"/m);
        if (modelMatch && !window.__codexState?.model) {
          if (!window.__codexState) window.__codexState = {};
          window.__codexState.model = modelMatch[1];
          needsReRender = true;
        }
        var subMatch = s.config.match(/\[agents\.subagent\]\s*\n\s*model\s*=\s*"([^"]+)"/m);
        if (subMatch && !window.__codexState?.subagentModel) {
          if (!window.__codexState) window.__codexState = {};
          window.__codexState.subagentModel = subMatch[1];
          needsReRender = true;
        }
      } else if (toolId === 'deepseek') {
        var urlMatch = s.config.match(/base_url\s*=\s*"([^"]+)"/);
        if (urlMatch && !s.baseUrl) s.baseUrl = urlMatch[1];
        var dsModel = s.config.match(/model\s*=\s*"([^"]+)"/m);
        if (dsModel && !s.model) {
          var inp = document.getElementById('deepseekModel');
          if (inp) inp.value = dsModel[1];
        }
      } else if (toolId === 'jcode') {
        var urlMatch = s.config.match(/base_url\s*=\s*"([^"]+)"/);
        if (urlMatch && !s.baseUrl) s.baseUrl = urlMatch[1];
      }
    }

    populateEndpointField(prefix, s.baseUrl);
    populateApiKeyField(prefix, s.apiKey);

    if (needsReRender) {
      reRenderDetailBody();
      populateEndpointField(prefix, s.baseUrl);
      populateApiKeyField(prefix, s.apiKey);
    }
  }

  window.backToCliTools = function () {
    cliToolDetailId = null;
    renderCliTools();
  };

  function reRenderDetailBody() {
    if (!cliToolDetailId) return;
    var meta = CLI_TOOL_META.find(function (m) { return m.id === cliToolDetailId; });
    if (!meta) return;
    var body = document.querySelector('.cli-tool-detail-body');
    if (!body) return;
    body.innerHTML = meta.render();
    applyTranslations();
    var toolId = cliToolDetailId;
    if (toolId === 'claude') bindClaudeEvents();
    else if (toolId === 'opencode') bindOcEvents();
    else if (toolId === 'cline') bindClineEvents();
    else if (toolId === 'codex') bindCodexEvents();
    else if (toolId === 'kilo') bindKiloEvents();
    else if (toolId === 'continue') bindContinueEvents();
    else if (toolId === 'roo') bindRooEvents();
    else if (toolId === 'deepseek') bindDeepSeekEvents();
    else if (toolId === 'jcode') bindJcodeEvents();
    else if (toolId === 'hermes') bindHermesEvents();
    else if (toolId === 'droid') bindDroidEvents();
    else if (toolId === 'openclaw') bindOpenClawEvents();
    else if (toolId === 'cursor') bindCursorEvents();
    else if (toolId === 'amp') bindAmpEvents();
    else if (toolId === 'qwen') bindQwenEvents();
    else if (toolId === 'cowork') bindCoworkEvents();
    else if (toolId === 'mitm') bindMitmEvents();
    else if (toolId === 'antigravity') bindAntigravityEvents();
    else if (toolId === 'copilot') bindCopilotEvents();
    else if (toolId === 'kiro') bindKiroEvents();
    populateAkSelect(cliToolDetailId);
  }

  function bindClaudeEvents() { bindEndpointApiKeyEvents('claude'); bindClaudeSlotEvents(); }
  function bindClaudeSlotEvents() {
    document.querySelectorAll('.claude-slot-input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        if (!window.claudeSlotState) window.claudeSlotState = {};
        window.claudeSlotState[this.dataset.slot] = this.value;
      });
    });
    document.querySelectorAll('.claude-slot-clear').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slot = this.dataset.slot;
        if (!window.claudeSlotState) window.claudeSlotState = {};
        window.claudeSlotState[slot] = '';
        reRenderDetailBody();
      });
    });
    document.querySelectorAll('.claude-slot-select').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (typeof openModelPicker === 'function') {
          var slot = this.dataset.slot;
          window.__cliModelCallback = function (model) {
            if (!window.claudeSlotState) window.claudeSlotState = {};
            window.claudeSlotState[slot] = model;
            reRenderDetailBody();
            closeDialog('modelPickerModal');
          };
          openModelPicker();
        }
      });
    });
  }
  function bindClineEvents() {
    bindEndpointApiKeyEvents('cline');
    var m = document.getElementById('clineModel');
    if (m) m.addEventListener('input', function () { window.__clineState.model = this.value; });
  }
  function bindCodexEvents() {
    bindEndpointApiKeyEvents('codex');
    var m = document.getElementById('codexModel');
    if (m) m.addEventListener('input', function () { window.__codexState.model = this.value; });
    var s = document.getElementById('codexSubagent');
    if (s) s.addEventListener('input', function () { window.__codexState.subagentModel = this.value; });
  }
  function bindKiloEvents() {
    bindEndpointApiKeyEvents('kilo');
    var m = document.getElementById('kiloModel');
    if (m) m.addEventListener('input', function () { window.__kiloState.model = this.value; });
  }
  function bindContinueEvents() {
    bindEndpointApiKeyEvents('continue');
    var m = document.getElementById('continueModel');
    if (m) m.addEventListener('input', function () { window.__continueState.model = this.value; updateContinueCode(); });
    var ak = document.getElementById('continue_ak');
    if (ak) ak.addEventListener('change', function () { window.__continueState.apiKey = this.value; updateContinueCode(); });
    var akC = document.getElementById('continue_akCustom');
    if (akC) akC.addEventListener('input', function () { window.__continueState.apiKey = this.value; updateContinueCode(); });
    updateContinueCode();
  }
  function bindRooEvents() {
    bindEndpointApiKeyEvents('roo');
    var m = document.getElementById('rooModel');
    if (m) m.addEventListener('input', function () { window.__rooState.model = this.value; });
  }
  function bindDeepSeekEvents() {
    bindEndpointApiKeyEvents('deepseek');
    var m = document.getElementById('deepseekModel');
    if (m) m.addEventListener('input', function () { window.__deepSeekState.model = this.value; });
  }
  function bindJcodeEvents() {
    bindEndpointApiKeyEvents('jcode');
  }
  function bindHermesEvents() {
    bindEndpointApiKeyEvents('hermes');
    var m = document.getElementById('hermesModel');
    if (m) m.addEventListener('input', function () { window.__hermesState.model = this.value; });
  }
  function bindDroidEvents() {
    bindEndpointApiKeyEvents('droid');
  }
  function bindOpenClawEvents() {
    bindEndpointApiKeyEvents('openclaw');
    var m = document.getElementById('openclawModel');
    if (m) m.addEventListener('input', function () { window.__openClawState.model = this.value; });
  }
  function bindCursorEvents() {
    bindEndpointApiKeyEvents('cursor');
  }
  function bindAmpEvents() {
    bindEndpointApiKeyEvents('amp');
    var m = document.getElementById('ampModel');
    if (m) m.addEventListener('input', function () { window.__ampState.model = this.value; updateAmpCode(); });
    var ak = document.getElementById('amp_ak');
    if (ak) ak.addEventListener('change', function () { updateAmpCode(); });
    var akC = document.getElementById('amp_akCustom');
    if (akC) akC.addEventListener('input', function () { updateAmpCode(); });
    updateAmpCode();
  }
  function bindQwenEvents() {
    bindEndpointApiKeyEvents('qwen');
    var m = document.getElementById('qwenModel');
    if (m) m.addEventListener('input', function () { window.__qwenState.model = this.value; updateQwenCode(); });
    var ak = document.getElementById('qwen_ak');
    if (ak) ak.addEventListener('change', function () { updateQwenCode(); });
    var akC = document.getElementById('qwen_akCustom');
    if (akC) akC.addEventListener('input', function () { updateQwenCode(); });
    updateQwenCode();
  }
  function bindCoworkEvents() {
    bindEndpointApiKeyEvents('cowork');
    var m = document.getElementById('coworkModel');
    if (m) m.addEventListener('input', function () { window.__coworkState.model = this.value; });
  }
  function bindMitmEvents() {
    var ak = document.getElementById('mitm_ak');
    if (ak) ak.addEventListener('change', function () {
      var c = document.getElementById('mitm_akCustom');
      if (c) c.classList.toggle('hidden', this.value !== 'custom');
    });
    populateAkSelect('mitm');
    mitmRefreshStatus();
  }
  function bindAntigravityEvents() {
    var ak = document.getElementById('antigravity_ak');
    if (ak) ak.addEventListener('change', function () {
      var c = document.getElementById('antigravity_akCustom');
      if (c) c.classList.toggle('hidden', this.value !== 'custom');
    });
    populateAkSelect('antigravity');
    // Sync alias inputs to state on change
    document.querySelectorAll('.ag-alias-input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        if (!window.__antigravityState.models) window.__antigravityState.models = {};
        window.__antigravityState.models[this.dataset.alias] = this.value;
      });
    });
    // Clear alias button
    document.querySelectorAll('.ag-alias-clear').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var alias = this.dataset.alias;
        if (!window.__antigravityState.models) window.__antigravityState.models = {};
        window.__antigravityState.models[alias] = '';
        reRenderDetailBody();
      });
    });
    // Select model button
    document.querySelectorAll('.ag-alias-select').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (typeof openModelPicker === 'function') {
          var alias = this.dataset.alias;
          window.__cliModelCallback = function (model) {
            if (!window.__antigravityState.models) window.__antigravityState.models = {};
            window.__antigravityState.models[alias] = model;
            reRenderDetailBody();
            closeDialog('modelPickerModal');
          };
          openModelPicker();
        }
      });
    });
  }
  function bindCopilotEvents() {
    bindEndpointApiKeyEvents('copilot');
  }
  function bindKiroEvents() {
    // Kiro doesn't need endpoint/ak bindings - just mapping rows
  }

  // Event wiring
  function bindLoginEvents() {
    $('loginBtn').addEventListener('click', login);
    $('pwdField').addEventListener('keypress', e => { if (e.key === 'Enter') login(); });

    const pwdToggle = $('pwdToggle');
    if (pwdToggle) {
      pwdToggle.addEventListener('click', () => {
        const f = $('pwdField');
        const willShow = f.type === 'password';
        f.type = willShow ? 'text' : 'password';
        pwdToggle.dataset.shown = String(willShow);
        pwdToggle.setAttribute('aria-label', willShow ? t('login.hidePassword') : t('login.showPassword'));
        pwdToggle.innerHTML = willShow
          ? '<i class="fa-solid fa-eye-slash"></i>'
          : '<i class="fa-solid fa-eye"></i>';
      });
    }
  }

  function bindCliToolEvents() {
    $('cliManualConfigClose').addEventListener('click', () => closeDialog('cliManualConfigModal'));
    bindDialogBackdropClose('cliManualConfigModal', () => closeDialog('cliManualConfigModal'));
  }

  function bindShellEvents() {
    const checkUpdateBtn = $('checkUpdateBtn');
    if (checkUpdateBtn) checkUpdateBtn.addEventListener('click', () => checkUpdate(true));

    const shutdownBtn = $('shutdownBtn');
    if (shutdownBtn) shutdownBtn.addEventListener('click', async () => {
      if (!confirm(t('footer.shutdownConfirm'))) return;
      shutdownBtn.disabled = true;
      try {
        await api('/shutdown', { method: 'POST' });
        toast(t('footer.shutdownSent'), 'primary');
      } catch (e) {
        toast(t('footer.shutdownSent'), 'primary');
      }
    });

    document.body.addEventListener('click', e => {
      if (!e.target.closest('.custom-select')) closeAllCustomSelects();
      const lb = e.target.closest('.lang-btn');
      if (lb) setLang(lb.dataset.lang);
      const lt = e.target.closest('.lang-toggle');
      if (lt) toggleLang();
    });
    window.addEventListener('resize', positionOpenCustomSelects);
    window.addEventListener('scroll', positionOpenCustomSelects, true);

    $('loginThemeToggle').addEventListener('click', toggleTheme);
    $('mainThemeToggle').addEventListener('click', toggleTheme);
    $('logoutBtn').addEventListener('click', logout);

    qsa('#tabBar .tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

    qsa('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.copy;
      const target = $(id);
      if (!target) return;
      try {
        await copyText(target.dataset.rawValue || target.textContent);
        toast(t('common.copied'), 'primary');
      } catch (e) {
        toast(t('common.failed'), 'error');
      }
    }));
  }

  function bindAccountEvents() {
    $('privacyModeToggle').addEventListener('change', e => {
      privacyModeEnabled = e.target.checked;
      localStorage.setItem('privacyMode', privacyModeEnabled);
      renderAccounts();
    });

    $('exportBtn').addEventListener('click', showExportModal);
    $('refreshAllModelsBtn').addEventListener('click', refreshAllModels);
    $('addAccountBtn').addEventListener('click', () => showModal('add'));

    $('selectAllCheckbox').addEventListener('change', e => toggleSelectAll(e.target.checked));
    qsa('[data-batch]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.batch;
      if (a === 'refreshModels') batchRefreshModels();
      else if (a === 'delete') batchDelete();
      else batchAction(a);
    }));

    $('filterSearch').addEventListener('input', onFilterChange);
    $('filterStatusSelect').addEventListener('change', onFilterChange);

    $('accountsList').addEventListener('click', e => {
      const cb = e.target.closest('.account-checkbox');
      if (cb) {
        toggleSelectAccount(cb.dataset.id);
        const card = cb.closest('.account-card');
        if (card) card.classList.toggle('selected', cb.checked);
        return;
      }
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === 'refresh') refreshAccount(id, btn.closest('.account-card'));
      else if (action === 'detail') showDetail(id);
      else if (action === 'copyJSON') copyAccountJSON(id, btn);
      else if (action === 'toggle') toggleAccount(id, btn.dataset.enabled === 'true');
      else if (action === 'test') testAccount(id);
      else if (action === 'delete') deleteAccount(id);
    });
  }

  function bindSettingsEvents() {
    $('saveRequireApiKeyBtn').addEventListener('click', saveRequireApiKey);
    $('saveOverUsageBtn').addEventListener('click', saveOverUsageConfig);
    $('saveThinkingBtn').addEventListener('click', saveThinkingConfig);
    $('saveEndpointBtn').addEventListener('click', saveEndpointConfig);
    $('changePasswordBtn').addEventListener('click', changePassword);
    $('proxyType').addEventListener('change', onProxyTypeChange);
    $('saveProxyBtn').addEventListener('click', saveProxyConfig);
    $('resetStatsBtn').addEventListener('click', resetStats);
    bindApiKeyEvents();
  }

  function bindPromptFilterEvents() {
    $('savePromptFilterBtn').addEventListener('click', savePromptFilter);
    $('addRuleRegexBtn').addEventListener('click', () => addPromptRule('regex'));
    $('addRuleContainsBtn').addEventListener('click', () => addPromptRule('lines-containing'));

    $('promptFilterRules').addEventListener('input', e => {
      const idx = e.target.dataset.ruleIdx;
      const field = e.target.dataset.ruleField;
      if (idx != null && field) promptRules[idx][field] = e.target.value;
    });
    $('promptFilterRules').addEventListener('change', e => {
      if (e.target.dataset.ruleToggle != null) {
        promptRules[e.target.dataset.ruleToggle].enabled = e.target.checked;
        renderPromptRules();
      }
    });
    $('promptFilterRules').addEventListener('click', e => {
      const rm = e.target.closest('[data-rule-remove]');
      if (rm) { promptRules.splice(parseInt(rm.dataset.ruleRemove, 10), 1); renderPromptRules(); }
    });
  }

  function bindModalEvents() {
    $('addModalClose').addEventListener('click', closeModal);
    $('detailModalClose').addEventListener('click', closeDetailModal);
    $('exportModalClose').addEventListener('click', closeExportModal);
    $('testModalClose').addEventListener('click', closeTestModal);
    $('updateModalClose').addEventListener('click', closeUpdateModal);
    [
      ['addModal', closeModal],
      ['detailModal', closeDetailModal],
      ['exportModal', closeExportModal],
      ['testModal', closeTestModal],
      ['updateModal', closeUpdateModal],
      ['confirmModal', () => closeConfirm(false)],
    ].forEach(([id, fn]) => bindDialogBackdropClose(id, fn));

    $('modalBody').addEventListener('click', e => {
      const m = e.target.closest('[data-method]');
      if (m) { showModal(m.dataset.method); return; }
      const g = e.target.closest('[data-modal-goto]');
      if (g) { showModal(g.dataset.modalGoto); return; }
      if (e.target.dataset.closeAdd) closeModal();
    });
  }

  function bindDetailEvents() {
    $('detailBody').addEventListener('click', e => {
      if (e.target.id === 'generateMachineIdBtn') { generateMachineId(); return; }
      const b = e.target.closest('[data-detail-action]');
      if (!b) return;
      const id = b.dataset.id;
      const a = b.dataset.detailAction;
      if (a === 'saveMachineId') saveMachineId(id);
      else if (a === 'saveWeight') saveWeight(id);
      else if (a === 'toggleOverage') toggleOverageSwitch(id, b);
      else if (a === 'refreshOverage') refreshAccountOverage(id);
      else if (a === 'saveProxyURL') saveProxyURL(id);
      else if (a === 'loadModels') loadModels(id);
      else if (a === 'refreshModels') refreshAccountModels(id);
    });
  }

  function bindTestEvents() {
    $('testBody').addEventListener('click', e => {
      if (e.target.id === 'testLogClear') { clearTestLog(); return; }
      if (e.target.id === 'testModalCancelBtn') { closeTestModal(); return; }
      const run = e.target.closest('#testRunBtn');
      if (run) runTestAccount(run.dataset.id, getTestModelValue());
    });
    $('testBody').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (!e.target.closest('#testModelChoice')) return;
      const run = $('testRunBtn');
      if (!run || run.disabled) return;
      e.preventDefault();
      runTestAccount(run.dataset.id, getTestModelValue());
    });
  }

  function wireEvents() {
    bindLoginEvents();
    bindShellEvents();
    bindAccountEvents();
    bindSettingsEvents();
    bindPromptFilterEvents();
    bindComboEvents();
    bindModalEvents();
    bindDetailEvents();
    bindTestEvents();
    bindCliToolEvents();
  }

  // Init
  async function init() {
    initTheme();
    await loadLocale(currentLang);
    if (currentLang !== 'zh') await loadLocale('zh');
    applyTranslations();
    initCustomSelectObserver();
    initPrivacyMode();
    initRememberMe();
    const yr = $('footerYear');
    if (yr) yr.textContent = new Date().getFullYear();
    wireEvents();
    if (password) tryAutoLogin();
    setInterval(() => {
      if (!$('mainPage').classList.contains('hidden')) loadStats();
    }, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
