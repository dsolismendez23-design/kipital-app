/* KI-PITAL
 * App sin frameworks: los datos viven como archivos JSON dentro de un
 * repositorio de GitHub y se leen/escriben con la API REST de GitHub.
 * Cada dispositivo guarda su propia conexión (owner/repo/token) en localStorage.
 */
(function () {
  'use strict';

  var CONFIG_KEY = 'kipital_gh_config_v1';
  var GH_API = 'https://api.github.com';
  var POLL_MS = 20000;
  var MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  var INGRESO_TIPOS = ['Tarjetas', 'Transferencia', 'Efectivo'];
  var EGRESO_TIPOS = ['Alquiler', 'Salarios', 'CCSS', 'Agua', 'Luz', 'Internet', 'Insumos', 'Otros'];
  var TIPO_PAGO_OPTS = ['Mensual', 'Quincenal', 'Semanal'];

  // Tarifas de referencia Costa Rica 2026 (ajustables en Configuración de nómina).
  var DEFAULT_NOMINA_CONFIG = {
    ccssTrabajador: 10.67,
    cargasPatronales: 26.83,
    tramos: [
      { hasta: 918000, tasa: 0 },
      { hasta: 1347000, tasa: 10 },
      { hasta: 2364000, tasa: 15 },
      { hasta: 4727000, tasa: 20 },
      { hasta: null, tasa: 25 }
    ]
  };

  var COLLECTIONS = {
    ingresos: { path: 'data/ingresos.json', kind: 'list' },
    egresos: { path: 'data/egresos.json', kind: 'list' },
    colaboradores: { path: 'data/colaboradores.json', kind: 'list' },
    nomina: { path: 'data/nomina.json', kind: 'list' },
    nominaConfig: { path: 'data/nomina_config.json', kind: 'object' },
  };

  var appEl = document.getElementById('app');
  var pollTimer = null;
  var toastTimer = null;

  function emptyData() {
    return {
      ingresos: { value: [], sha: null, loaded: false },
      egresos: { value: [], sha: null, loaded: false },
      colaboradores: { value: [], sha: null, loaded: false },
      nomina: { value: [], sha: null, loaded: false },
      nominaConfig: { value: null, sha: null, loaded: false },
    };
  }

  var state = {
    config: loadConfig(),
    data: emptyData(),
    syncStatus: 'idle', // idle | syncing | ok | error
    lastSync: null,
    tab: 'inicio', // inicio | ingresos | egresos | rrhh
    rrhhTab: 'colaboradores', // colaboradores | nomina
    screen: null,
    editingId: null,
    movKind: null, // 'ingresos' | 'egresos' (formulario de movimiento)
    period: defaultPeriod(),
    quickPeriod: 'month',
    planillaDraft: null,
    toast: null,
    configVerifying: false,
    configError: null,
    showToken: false,
    deferredInstallPrompt: null,
  };

  // ---------- Utilidades ----------

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function toISODate(d) {
    var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function defaultPeriod() {
    var now = new Date();
    var first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { desde: toISODate(first), hasta: toISODate(now) };
  }

  function currentMonthValue() {
    var now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  }

  function lastDayOfMonth(ym) {
    if (!ym || ym.indexOf('-') === -1) return toISODate(new Date());
    var parts = ym.split('-');
    var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
    return toISODate(new Date(y, m, 0));
  }

  function formatMoneyNumber(n) {
    var v = Number(n || 0);
    var sign = v < 0 ? '-' : '';
    var fixed = Math.abs(v).toFixed(2);
    var parts = fixed.split('.');
    var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return sign + intPart + ',' + parts[1];
  }
  function formatMoney(n) { return '₡' + formatMoneyNumber(n); }
  function formatMoneyPdf(n) { return 'CRC ' + formatMoneyNumber(n); }

  function formatDateDisplay(iso) {
    if (!iso) return '';
    var parts = iso.split('-');
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }

  function monthLabel(ym) {
    if (!ym || ym.indexOf('-') === -1) return ym || '—';
    var parts = ym.split('-');
    var idx = parseInt(parts[1], 10) - 1;
    return (MESES[idx] || ym) + ' ' + parts[0];
  }

  function timeAgo(date) {
    if (!date) return 'sin sincronizar';
    var s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 10) return 'ahora mismo';
    if (s < 60) return 'hace ' + s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return 'hace ' + m + ' min';
    var h = Math.floor(m / 60);
    return 'hace ' + h + ' h';
  }

  // ---------- Config (localStorage por dispositivo) ----------

  function loadConfig() {
    try {
      var raw = localStorage.getItem(CONFIG_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function persistConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }
  function clearConfig() {
    localStorage.removeItem(CONFIG_KEY);
  }

  // ---------- Codificación UTF-8 <-> Base64 ----------

  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = '';
    bytes.forEach(function (b) { binary += String.fromCharCode(b); });
    return btoa(binary);
  }
  function base64ToUtf8(b64) {
    var binary = atob(b64.replace(/\n/g, ''));
    var bytes = Uint8Array.from(binary, function (c) { return c.charCodeAt(0); });
    return new TextDecoder().decode(bytes);
  }

  // ---------- API de GitHub (genérica por colección) ----------

  function ApiError(status, message) {
    this.status = status;
    this.message = message;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function ghRequest(cfg, path, options) {
    options = options || {};
    var headers = Object.assign({
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + cfg.token,
      'X-GitHub-Api-Version': '2022-11-28',
    }, options.headers || {});
    return fetch(GH_API + path, Object.assign({ cache: 'no-store' }, options, { headers: headers }));
  }

  function safeJson(res) {
    return res.json().catch(function () { return null; });
  }

  function defaultForKind(name) {
    if (COLLECTIONS[name].kind === 'object') {
      return name === 'nominaConfig' ? JSON.parse(JSON.stringify(DEFAULT_NOMINA_CONFIG)) : {};
    }
    return [];
  }

  function fetchCollection(name) {
    var cfg = state.config;
    var path = COLLECTIONS[name].path;
    var url = '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
      '/contents/' + path + '?ref=' + encodeURIComponent(cfg.branch);
    return ghRequest(cfg, url).then(function (res) {
      if (res.status === 404) return { value: defaultForKind(name), sha: null };
      if (!res.ok) {
        return safeJson(res).then(function (err) {
          throw new ApiError(res.status, (err && err.message) || ('Error ' + res.status));
        });
      }
      return res.json().then(function (json) {
        var text = base64ToUtf8(json.content);
        var parsed;
        try { parsed = JSON.parse(text); } catch (e) { parsed = defaultForKind(name); }
        if (COLLECTIONS[name].kind === 'list' && !Array.isArray(parsed)) parsed = [];
        return { value: parsed, sha: json.sha };
      });
    });
  }

  function saveCollection(name, value, sha) {
    var cfg = state.config;
    var path = COLLECTIONS[name].path;
    var url = '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/contents/' + path;
    var body = {
      message: 'Actualiza ' + name + ' (KI-PITAL app)',
      content: utf8ToBase64(JSON.stringify(value, null, 2)),
      branch: cfg.branch,
    };
    if (sha) body.sha = sha;
    return ghRequest(cfg, url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) {
        return safeJson(res).then(function (err) {
          throw new ApiError(res.status, (err && err.message) || ('Error ' + res.status));
        });
      }
      return res.json().then(function (json) { return json.content.sha; });
    });
  }

  function friendlyError(e) {
    if (e instanceof ApiError) {
      if (e.status === 401) return 'Token inválido o vencido. Revisa la Configuración.';
      if (e.status === 404) return 'No se encontró el repositorio. Revisa la Configuración.';
      if (e.status === 403) return 'Sin permisos, o se alcanzó el límite de solicitudes. Intenta de nuevo en un momento.';
      if (e.status === 409 || e.status === 422) return 'Otro dispositivo guardó al mismo tiempo. Intenta de nuevo.';
    }
    return 'No se pudo conectar. Revisa tu conexión a internet.';
  }

  function mutateCollection(name, mutatorFn, opts) {
    opts = opts || {};
    setSyncStatus('syncing');
    var attempt = 0;
    function tryOnce() {
      attempt++;
      return fetchCollection(name).then(function (res) {
        var current = COLLECTIONS[name].kind === 'list' ? res.value.slice() : Object.assign({}, res.value);
        var updated = mutatorFn(current);
        return saveCollection(name, updated, res.sha).then(function (newSha) {
          state.data[name].value = updated;
          state.data[name].sha = newSha;
          state.data[name].loaded = true;
          state.lastSync = new Date();
          setSyncStatus('ok');
          if (opts.onSuccess) opts.onSuccess(updated);
          if (opts.successMessage) state.toast = { msg: opts.successMessage, isError: false };
          render();
          scheduleToastClear();
          return updated;
        });
      }).catch(function (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 422) && attempt < 4) {
          return tryOnce();
        }
        setSyncStatus('error');
        state.toast = { msg: friendlyError(e), isError: true };
        render();
        scheduleToastClear();
        return false;
      });
    }
    return tryOnce();
  }

  function setSyncStatus(status) { state.syncStatus = status; }

  function scheduleToastClear() {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { state.toast = null; render(); }, 3200);
  }

  function showToast(msg, isError) {
    state.toast = { msg: msg, isError: !!isError };
    render();
    scheduleToastClear();
  }

  // ---------- Carga y sincronización (según la vista activa) ----------

  function neededCollectionsForView() {
    if (state.tab === 'inicio') return ['ingresos', 'egresos'];
    if (state.tab === 'ingresos') return ['ingresos'];
    if (state.tab === 'egresos') return ['egresos'];
    if (state.tab === 'rrhh') {
      if (state.rrhhTab === 'colaboradores') return ['colaboradores'];
      return ['colaboradores', 'nomina', 'nominaConfig'];
    }
    return [];
  }

  function ensureLoaded(names) {
    var toFetch = names.filter(function (n) { return !state.data[n].loaded; });
    if (!toFetch.length) { restartPollingForCurrentView(); return Promise.resolve(); }
    setSyncStatus('syncing');
    render();
    return Promise.all(toFetch.map(function (n) {
      return fetchCollection(n).then(function (res) {
        state.data[n].value = res.value;
        state.data[n].sha = res.sha;
        state.data[n].loaded = true;
      });
    })).then(function () {
      state.lastSync = new Date();
      setSyncStatus('ok');
      render();
      restartPollingForCurrentView();
    }).catch(function (e) {
      setSyncStatus('error');
      showToast(friendlyError(e), true);
      restartPollingForCurrentView();
    });
  }

  function refreshCurrentView() {
    if (!state.config) return Promise.resolve();
    var names = neededCollectionsForView();
    if (!names.length) return Promise.resolve();
    setSyncStatus('syncing');
    updateSyncDomOnly();
    return Promise.all(names.map(function (n) {
      return fetchCollection(n).then(function (res) {
        state.data[n].value = res.value;
        state.data[n].sha = res.sha;
        state.data[n].loaded = true;
      });
    })).then(function () {
      state.lastSync = new Date();
      setSyncStatus('ok');
      backgroundDataUpdated();
    }).catch(function () {
      setSyncStatus('error');
      backgroundDataUpdated();
    });
  }

  function backgroundDataUpdated() {
    if (state.screen) {
      updateSyncDomOnly();
    } else {
      render();
    }
  }

  function updateSyncDomOnly() {
    var dot = document.querySelector('[data-sync-dot]');
    var label = document.querySelector('[data-sync-label]');
    if (dot) dot.className = 'dot ' + (state.syncStatus === 'ok' ? 'ok' : state.syncStatus === 'error' ? 'err' : '');
    if (label) label.textContent = syncLabelText();
  }

  function syncLabelText() {
    if (state.syncStatus === 'syncing') return 'Sincronizando…';
    if (state.syncStatus === 'error') return 'Sin conexión';
    return timeAgo(state.lastSync);
  }

  function restartPollingForCurrentView() {
    stopPolling();
    pollTimer = setInterval(function () { if (!document.hidden) refreshCurrentView(); }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshCurrentView();
  });

  // ---------- Instalar como app ----------

  function isIosDevice() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  }
  function isStandaloneApp() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    if (!state.screen) render();
  });
  window.addEventListener('appinstalled', function () {
    state.deferredInstallPrompt = null;
    if (!state.screen) render();
  });

  function installApp() {
    var promptEvent = state.deferredInstallPrompt;
    if (!promptEvent) return;
    state.deferredInstallPrompt = null;
    promptEvent.prompt();
    promptEvent.userChoice.then(function () { render(); }).catch(function () {});
  }

  function loadInitialData() {
    if (!state.config) return;
    ensureLoaded(neededCollectionsForView());
  }

  // ---------- Navegación ----------

  function switchTab(tab) {
    state.tab = tab;
    state.screen = null;
    render();
    ensureLoaded(neededCollectionsForView());
  }
  function switchRrhhTab(rt) {
    state.rrhhTab = rt;
    render();
    ensureLoaded(neededCollectionsForView());
  }
  function closeScreen() {
    state.screen = null; state.editingId = null; state.configError = null; state.movKind = null; state.planillaDraft = null;
    render();
  }
  function openConfig() { state.configError = null; state.screen = 'config'; render(); }
  function toggleTokenVisibility() { state.showToken = !state.showToken; render(); }

  function setQuickPeriod(kind) {
    var now = new Date(), desde, hasta;
    if (kind === 'today') { desde = now; hasta = now; }
    else if (kind === 'month') { desde = new Date(now.getFullYear(), now.getMonth(), 1); hasta = now; }
    else if (kind === 'lastmonth') { desde = new Date(now.getFullYear(), now.getMonth() - 1, 1); hasta = new Date(now.getFullYear(), now.getMonth(), 0); }
    else if (kind === 'year') { desde = new Date(now.getFullYear(), 0, 1); hasta = now; }
    else { desde = null; hasta = null; }
    state.period = { desde: desde ? toISODate(desde) : '', hasta: hasta ? toISODate(hasta) : '' };
    state.quickPeriod = kind;
    render();
  }

  function filterByPeriod(list) {
    var desde = state.period.desde, hasta = state.period.hasta;
    return list.filter(function (g) {
      if (desde && g.fecha < desde) return false;
      if (hasta && g.fecha > hasta) return false;
      return true;
    });
  }

  function groupBy(list, key) {
    var map = {}, order = [];
    list.forEach(function (g) {
      var k = (g[key] || '(sin dato)');
      if (!map[k]) { map[k] = { name: k, total: 0, count: 0 }; order.push(k); }
      map[k].total += Number(g.monto) || 0;
      map[k].count++;
    });
    return order.map(function (k) { return map[k]; }).sort(function (a, b) { return b.total - a.total; });
  }

  // ---------- Ingresos / Egresos ----------

  function tiposFor(kind) { return kind === 'ingresos' ? INGRESO_TIPOS : EGRESO_TIPOS; }
  function labelFor(kind) { return kind === 'ingresos' ? 'ingreso' : 'egreso'; }

  function openNewMovForm(kind) { state.movKind = kind; state.editingId = null; state.screen = 'mov-form'; render(); }
  function openEditMovForm(kind, id) { state.movKind = kind; state.editingId = id; state.screen = 'mov-form'; render(); }

  function deleteMov(kind, id) {
    if (!window.confirm('¿Eliminar este ' + labelFor(kind) + '? Esta acción no se puede deshacer.')) return;
    mutateCollection(kind, function (list) { return list.filter(function (g) { return g.id !== id; }); }, {
      successMessage: labelFor(kind) === 'ingreso' ? 'Ingreso eliminado' : 'Egreso eliminado',
      onSuccess: function () { state.screen = null; state.editingId = null; state.movKind = null; },
    });
  }

  function onSubmitMovForm(fd) {
    var kind = state.movKind;
    var fecha = fd.get('fecha');
    var tipo = fd.get('tipo');
    var monto = parseFloat(fd.get('monto'));
    var nota = (fd.get('nota') || '').trim();
    if (!fecha || !tipo || isNaN(monto) || monto <= 0) {
      showToast('Completa fecha, tipo y un monto válido (mayor a 0).', true);
      return;
    }
    var editingId = state.editingId;
    mutateCollection(kind, function (list) {
      if (editingId) {
        return list.map(function (g) {
          return g.id === editingId ? Object.assign({}, g, { fecha: fecha, tipo: tipo, monto: monto, nota: nota }) : g;
        });
      }
      return list.concat([{ id: genId(), fecha: fecha, tipo: tipo, monto: monto, nota: nota, creadoEn: new Date().toISOString() }]);
    }, {
      successMessage: editingId ? 'Registro actualizado' : 'Registro guardado',
      onSuccess: function () { state.screen = null; state.editingId = null; state.movKind = null; },
    });
  }

  // ---------- Colaboradores ----------

  function openNewColabForm() { state.editingId = null; state.screen = 'colab-form'; render(); }
  function openEditColabForm(id) { state.editingId = id; state.screen = 'colab-form'; render(); }

  function deleteColab(id) {
    if (!window.confirm('¿Eliminar este colaborador? Las planillas ya guardadas no se borran.')) return;
    mutateCollection('colaboradores', function (list) { return list.filter(function (c) { return c.id !== id; }); }, {
      successMessage: 'Colaborador eliminado',
      onSuccess: function () { state.screen = null; state.editingId = null; },
    });
  }

  function onSubmitColabForm(fd) {
    var nombre = (fd.get('nombre') || '').trim();
    var cedula = (fd.get('cedula') || '').trim();
    var telefono = (fd.get('telefono') || '').trim();
    var email = (fd.get('email') || '').trim();
    var direccion = (fd.get('direccion') || '').trim();
    var puesto = (fd.get('puesto') || '').trim();
    var salario = parseFloat(fd.get('salario'));
    var tipoPago = fd.get('tipoPago') || 'Mensual';
    var fechaIngreso = fd.get('fechaIngreso');
    var estado = fd.get('estado') === 'on' ? 'activo' : 'inactivo';
    if (!nombre || !puesto || isNaN(salario) || salario <= 0 || !fechaIngreso) {
      showToast('Completa al menos nombre, puesto, salario y fecha de ingreso.', true);
      return;
    }
    var editingId = state.editingId;
    var payload = { nombre: nombre, cedula: cedula, telefono: telefono, email: email, direccion: direccion, puesto: puesto, salario: salario, tipoPago: tipoPago, fechaIngreso: fechaIngreso, estado: estado };
    mutateCollection('colaboradores', function (list) {
      if (editingId) {
        return list.map(function (c) { return c.id === editingId ? Object.assign({}, c, payload) : c; });
      }
      return list.concat([Object.assign({ id: genId(), creadoEn: new Date().toISOString() }, payload)]);
    }, {
      successMessage: editingId ? 'Colaborador actualizado' : 'Colaborador guardado',
      onSuccess: function () { state.screen = null; state.editingId = null; },
    });
  }

  // ---------- Nómina: configuración de tarifas ----------

  function openNominaConfigScreen() { state.screen = 'nomina-config'; render(); }

  function currentNominaConfig() {
    return state.data.nominaConfig.value || DEFAULT_NOMINA_CONFIG;
  }

  function onSubmitNominaConfigForm(fd) {
    var ccssTrabajador = parseFloat(fd.get('ccssTrabajador'));
    var cargasPatronales = parseFloat(fd.get('cargasPatronales'));
    if (isNaN(ccssTrabajador) || ccssTrabajador < 0 || isNaN(cargasPatronales) || cargasPatronales < 0) {
      showToast('Revisa los porcentajes de CCSS y cargas patronales.', true);
      return;
    }
    var tramos = [];
    for (var i = 0; i < 5; i++) {
      var tasa = parseFloat(fd.get('tramo' + i + '_tasa'));
      if (isNaN(tasa)) tasa = 0;
      if (i < 4) {
        var hasta = parseFloat(fd.get('tramo' + i + '_hasta'));
        tramos.push({ hasta: isNaN(hasta) ? 0 : hasta, tasa: tasa });
      } else {
        tramos.push({ hasta: null, tasa: tasa });
      }
    }
    var newConfig = { ccssTrabajador: ccssTrabajador, cargasPatronales: cargasPatronales, tramos: tramos, actualizadoEn: new Date().toISOString() };
    mutateCollection('nominaConfig', function () { return newConfig; }, {
      successMessage: 'Parámetros de nómina actualizados',
      onSuccess: function () { state.screen = null; },
    });
  }

  function restoreNominaConfigDefaults() {
    if (!window.confirm('¿Restaurar los valores de referencia 2026 (CCSS 10.67%, cargas patronales 26.83% y tramos de renta vigentes)?')) return;
    var newConfig = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_NOMINA_CONFIG)), { actualizadoEn: new Date().toISOString() });
    mutateCollection('nominaConfig', function () { return newConfig; }, {
      successMessage: 'Valores restaurados',
      onSuccess: function () { state.screen = null; },
    });
  }

  // ---------- Nómina: cálculo ----------

  function calcularRenta(salarioBruto, tramos) {
    if (!tramos || !tramos.length) return 0;
    var renta = 0, prev = 0;
    for (var i = 0; i < tramos.length; i++) {
      var t = tramos[i];
      var techo = (t.hasta == null) ? Infinity : Number(t.hasta);
      if (salarioBruto > prev) {
        var base = Math.min(salarioBruto, techo) - prev;
        if (base > 0) renta += base * (Number(t.tasa) || 0) / 100;
      }
      prev = techo;
      if (salarioBruto <= techo) break;
    }
    return renta;
  }

  function computePlanillaFila(fila, cfg) {
    var base = Number(fila.salarioBase) || 0;
    var bonos = Number(fila.bonos) || 0;
    var otras = Number(fila.otrasDeducciones) || 0;
    var bruto = base + bonos;
    var ccss = bruto * (Number(cfg.ccssTrabajador) || 0) / 100;
    var renta = calcularRenta(bruto, cfg.tramos || []);
    var dedTotal = ccss + renta + otras;
    var neto = bruto - dedTotal;
    var cargasPatronales = bruto * (Number(cfg.cargasPatronales) || 0) / 100;
    var costoTotal = bruto + cargasPatronales;
    return {
      colaboradorId: fila.colaboradorId, nombre: fila.nombre, puesto: fila.puesto,
      salarioBase: base, bonos: bonos, otrasDeducciones: otras,
      salarioBruto: bruto, ccssTrabajador: ccss, renta: renta, deduccionesTotal: dedTotal,
      salarioNeto: neto, cargasPatronales: cargasPatronales, costoTotal: costoTotal,
    };
  }

  function openNewPlanillaForm() {
    var colaboradores = state.data.colaboradores.value || [];
    if (!colaboradores.filter(function (c) { return c.estado !== 'inactivo'; }).length) {
      showToast('Primero agrega al menos un colaborador activo en RRHH.', true);
      return;
    }
    var periodoMes = currentMonthValue();
    state.planillaDraft = {
      periodoMes: periodoMes,
      fechaPago: lastDayOfMonth(periodoMes),
      filas: buildFilasForPeriod(periodoMes),
    };
    state.screen = 'planilla-form';
    render();
  }

  function buildFilasForPeriod(periodoMes) {
    var hasta = lastDayOfMonth(periodoMes);
    var colaboradores = state.data.colaboradores.value || [];
    return colaboradores
      .filter(function (c) { return c.estado !== 'inactivo' && (!c.fechaIngreso || c.fechaIngreso <= hasta); })
      .map(function (c) {
        return { colaboradorId: c.id, nombre: c.nombre, puesto: c.puesto, salarioBase: c.salario, bonos: 0, otrasDeducciones: 0 };
      });
  }

  function planillaPeriodoChanged(periodoMes) {
    if (!state.planillaDraft) return;
    state.planillaDraft.periodoMes = periodoMes;
    state.planillaDraft.fechaPago = lastDayOfMonth(periodoMes);
    state.planillaDraft.filas = buildFilasForPeriod(periodoMes);
    render();
  }

  function removeFilaPlanilla(idx) {
    if (!state.planillaDraft) return;
    state.planillaDraft.filas.splice(idx, 1);
    render();
  }

  function savePlanilla() {
    var draft = state.planillaDraft;
    if (!draft || !draft.filas.length) { showToast('No hay colaboradores en esta planilla.', true); return; }
    if (!draft.fechaPago) { showToast('Indica la fecha de pago.', true); return; }
    var cfg = currentNominaConfig();
    var detalle = draft.filas.map(function (f) { return computePlanillaFila(f, cfg); });
    var totals = detalle.reduce(function (acc, d) {
      acc.totalBruto += d.salarioBruto;
      acc.totalCcssTrabajador += d.ccssTrabajador;
      acc.totalRenta += d.renta;
      acc.totalOtrasDeducciones += d.otrasDeducciones;
      acc.totalNeto += d.salarioNeto;
      acc.totalCargasPatronales += d.cargasPatronales;
      acc.totalCostoPatronal += d.costoTotal;
      return acc;
    }, { totalBruto: 0, totalCcssTrabajador: 0, totalRenta: 0, totalOtrasDeducciones: 0, totalNeto: 0, totalCargasPatronales: 0, totalCostoPatronal: 0 });

    var planilla = Object.assign({
      id: genId(),
      periodoMes: draft.periodoMes,
      fechaPago: draft.fechaPago,
      detalle: detalle,
      registradoEnEgresos: false,
      creadoEn: new Date().toISOString(),
    }, totals);

    mutateCollection('nomina', function (list) { return list.concat([planilla]); }, {
      successMessage: 'Planilla guardada',
      onSuccess: function () { state.screen = null; state.planillaDraft = null; },
    });
  }

  function viewPlanilla(id) { state.editingId = id; state.screen = 'planilla-detail'; render(); }

  function deletePlanilla(id) {
    if (!window.confirm('¿Eliminar esta planilla? Esta acción no se puede deshacer. No afecta egresos ya registrados.')) return;
    mutateCollection('nomina', function (list) { return list.filter(function (p) { return p.id !== id; }); }, {
      successMessage: 'Planilla eliminada',
      onSuccess: function () { state.screen = null; state.editingId = null; },
    });
  }

  function findPlanilla(id) {
    return (state.data.nomina.value || []).find(function (p) { return p.id === id; });
  }

  function registrarPlanillaEnEgresos(id) {
    var planilla = findPlanilla(id);
    if (!planilla || planilla.registradoEnEgresos) return;
    var ccssTotal = planilla.totalCcssTrabajador + planilla.totalCargasPatronales;
    var lineas = ['Salarios: ' + formatMoney(planilla.totalNeto) + ' (pago neto a colaboradores)',
      'CCSS: ' + formatMoney(ccssTotal) + ' (cuota trabajador + cargas patronales)'];
    if (planilla.totalRenta > 0) lineas.push('Otros: ' + formatMoney(planilla.totalRenta) + ' (renta retenida a remitir a Hacienda)');
    var msg = 'Se registrarán estos egresos con fecha ' + formatDateDisplay(planilla.fechaPago) + ' por la planilla de ' + monthLabel(planilla.periodoMes) + ':\n\n' + lineas.join('\n') + '\n\n¿Continuar?';
    if (!window.confirm(msg)) return;

    var nuevos = [
      { id: genId(), fecha: planilla.fechaPago, tipo: 'Salarios', monto: planilla.totalNeto, nota: 'Planilla ' + monthLabel(planilla.periodoMes) + ' (pago neto)', creadoEn: new Date().toISOString() },
      { id: genId(), fecha: planilla.fechaPago, tipo: 'CCSS', monto: ccssTotal, nota: 'Planilla ' + monthLabel(planilla.periodoMes) + ' (cuota trabajador + patronal)', creadoEn: new Date().toISOString() },
    ];
    if (planilla.totalRenta > 0) {
      nuevos.push({ id: genId(), fecha: planilla.fechaPago, tipo: 'Otros', monto: planilla.totalRenta, nota: 'Renta retenida - Planilla ' + monthLabel(planilla.periodoMes), creadoEn: new Date().toISOString() });
    }

    mutateCollection('egresos', function (list) { return list.concat(nuevos); }, {
      onSuccess: function () {
        mutateCollection('nomina', function (list) {
          return list.map(function (p) { return p.id === id ? Object.assign({}, p, { registradoEnEgresos: true }) : p; });
        }, { successMessage: 'Egresos registrados a partir de la planilla' });
      },
    });
  }

  // ---------- Configuración de GitHub ----------

  function onSubmitConfigForm(fd) {
    var owner = (fd.get('owner') || '').trim();
    var repo = (fd.get('repo') || '').trim();
    var branch = (fd.get('branch') || '').trim() || 'main';
    var token = (fd.get('token') || '').trim();
    if (!owner || !repo || !token) {
      state.configError = 'Completa usuario/organización, repositorio y token.';
      render();
      return;
    }
    var testConfig = { owner: owner, repo: repo, branch: branch, token: token };
    var prevConfig = state.config;
    state.configVerifying = true;
    state.configError = null;
    state.config = testConfig;
    render();
    fetchCollection('ingresos').then(function (data) {
      persistConfig(testConfig);
      state.data.ingresos.value = data.value;
      state.data.ingresos.sha = data.sha;
      state.data.ingresos.loaded = true;
      state.lastSync = new Date();
      state.syncStatus = 'ok';
      state.configVerifying = false;
      state.screen = null;
      render();
      showToast('Conectado correctamente');
      restartPollingForCurrentView();
    }).catch(function (e) {
      state.config = prevConfig;
      state.configVerifying = false;
      state.configError = friendlyError(e);
      render();
    });
  }

  function resetConfig() {
    if (!window.confirm('¿Desconectar este dispositivo? Deberás ingresar el token nuevamente para volver a usar la app aquí.')) return;
    clearConfig();
    stopPolling();
    state.config = null;
    state.data = emptyData();
    state.screen = 'config';
    render();
  }

  function copyConfigForSharing() {
    var cfg = state.config;
    if (!cfg) return;
    var code = [cfg.owner, cfg.repo, cfg.branch || 'main', cfg.token].join('|');
    var done = function () { showToast('Configuración copiada. Compártela solo por un canal seguro con tu equipo.'); };
    var fallback = function () { window.prompt('Copia este código de configuración:', code); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function usePastedConfig() {
    var input = document.getElementById('c-paste');
    var raw = (input ? input.value : '').trim();
    var parts = raw.split('|').map(function (s) { return s.trim(); });
    if (parts.length !== 4 || !parts[0] || !parts[1] || !parts[3]) {
      showToast('Ese código no es válido. Pídele a tu compañero que use "Copiar configuración" y pega el texto completo.', true);
      return;
    }
    var fd = new FormData();
    fd.append('owner', parts[0]);
    fd.append('repo', parts[1]);
    fd.append('branch', parts[2] || 'main');
    fd.append('token', parts[3]);
    onSubmitConfigForm(fd);
  }

  // ---------- PDF de planilla ----------

  function buildPlanillaPdfDoc(planilla) {
    var doc = new jspdf.jsPDF();
    var y = 20;
    var pageH = 280;
    function ensureSpace(need) { if (y + need > pageH) { doc.addPage(); y = 20; } }

    doc.setFontSize(16);
    doc.text('KI-PITAL - Planilla de nómina', 14, y); y += 8;
    doc.setFontSize(10);
    doc.text('Período: ' + monthLabel(planilla.periodoMes), 14, y); y += 6;
    doc.text('Fecha de pago: ' + formatDateDisplay(planilla.fechaPago), 14, y); y += 6;
    doc.text('Generado: ' + new Date().toLocaleString('es-CR'), 14, y); y += 12;

    doc.setFontSize(9);
    planilla.detalle.forEach(function (d) {
      ensureSpace(26);
      doc.setFontSize(11);
      doc.text(String(d.nombre), 14, y);
      doc.setFontSize(9);
      doc.text(String(d.puesto || ''), 140, y);
      y += 6;
      doc.text('Bruto: ' + formatMoneyPdf(d.salarioBruto), 14, y);
      doc.text('CCSS: ' + formatMoneyPdf(d.ccssTrabajador), 80, y);
      doc.text('Renta: ' + formatMoneyPdf(d.renta), 140, y);
      y += 5;
      doc.text('Otras deducc.: ' + formatMoneyPdf(d.otrasDeducciones), 14, y);
      doc.text('Neto a pagar: ' + formatMoneyPdf(d.salarioNeto), 80, y);
      doc.text('Costo patronal: ' + formatMoneyPdf(d.costoTotal), 140, y);
      y += 8;
    });

    ensureSpace(40);
    y += 4;
    doc.setFontSize(12);
    doc.text('Totales de la planilla', 14, y); y += 8;
    doc.setFontSize(10);
    doc.text('Total bruto: ' + formatMoneyPdf(planilla.totalBruto), 14, y); y += 6;
    doc.text('Total CCSS trabajador: ' + formatMoneyPdf(planilla.totalCcssTrabajador), 14, y); y += 6;
    doc.text('Total renta retenida: ' + formatMoneyPdf(planilla.totalRenta), 14, y); y += 6;
    doc.text('Total neto a pagar: ' + formatMoneyPdf(planilla.totalNeto), 14, y); y += 6;
    doc.text('Total cargas patronales: ' + formatMoneyPdf(planilla.totalCargasPatronales), 14, y); y += 6;
    doc.text('Costo total patronal (bruto + cargas): ' + formatMoneyPdf(planilla.totalCostoPatronal), 14, y); y += 6;

    return doc;
  }

  function downloadOrSharePlanillaPdf(id) {
    if (typeof jspdf === 'undefined') {
      showToast('No se pudo generar el PDF (sin conexión a internet la primera vez).', true);
      return;
    }
    var planilla = findPlanilla(id);
    if (!planilla) return;
    var doc = buildPlanillaPdfDoc(planilla);
    var filename = 'kipital-planilla-' + planilla.periodoMes + '.pdf';
    var blob = doc.output('blob');
    var file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Planilla KI-PITAL', text: 'Planilla de nómina KI-PITAL' }).catch(function () {});
    } else {
      doc.save(filename);
    }
  }

  // ---------- Render ----------

  function withFocusPreserved(fn) {
    var active = document.activeElement;
    var id = active && active.id;
    var start = active && 'selectionStart' in active ? active.selectionStart : null;
    var end = active && 'selectionStart' in active ? active.selectionEnd : null;
    fn();
    if (id) {
      var el = document.getElementById(id);
      if (el) {
        el.focus();
        if (start != null && el.setSelectionRange) {
          try { el.setSelectionRange(start, end); } catch (e) {}
        }
      }
    }
  }

  function render() { withFocusPreserved(paint); }

  function paint() {
    appEl.innerHTML = renderHeader() + renderMain() + renderTabbar() + renderScreen() + renderToast();
  }

  function renderHeader() {
    var dotClass = state.syncStatus === 'ok' ? 'ok' : state.syncStatus === 'error' ? 'err' : '';
    return (
      '<div class="header">' +
        '<div class="brand">' +
          '<div class="logo">KI</div>' +
          '<div><h1>KI-PITAL</h1><small>Ingresos · Egresos · RRHH</small></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<div class="sync-status">' +
            '<span class="dot ' + dotClass + '" data-sync-dot></span>' +
            '<span data-sync-label>' + escapeHtml(syncLabelText()) + '</span>' +
          '</div>' +
          '<button class="icon-btn" data-action="refresh" title="Actualizar">&#8635;</button>' +
          '<button class="icon-btn" data-action="open-config" title="Configuración">&#9881;</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderTabbar() {
    return (
      '<div class="tabbar"><div class="tabbar-inner">' +
        '<button class="tab-btn ' + (state.tab === 'inicio' ? 'active' : '') + '" data-action="tab" data-tab="inicio">' +
          '<span class="ic">&#127968;</span>Inicio</button>' +
        '<button class="tab-btn ' + (state.tab === 'ingresos' ? 'active' : '') + '" data-action="tab" data-tab="ingresos">' +
          '<span class="ic">&#128176;</span>Ingresos</button>' +
        '<button class="tab-btn ' + (state.tab === 'egresos' ? 'active' : '') + '" data-action="tab" data-tab="egresos">' +
          '<span class="ic">&#128179;</span>Egresos</button>' +
        '<button class="tab-btn ' + (state.tab === 'rrhh' ? 'active' : '') + '" data-action="tab" data-tab="rrhh">' +
          '<span class="ic">&#128101;</span>RRHH</button>' +
      '</div></div>'
    );
  }

  function renderMain() {
    if (!state.config) {
      return '<main>' + renderSetupHero() + '</main>';
    }
    if (state.tab === 'inicio') return '<main>' + renderInicioTab() + '</main>';
    if (state.tab === 'ingresos') return '<main>' + renderRefreshBar() + renderMovTab('ingresos') + '</main>' + renderFab('ingresos');
    if (state.tab === 'egresos') return '<main>' + renderRefreshBar() + renderMovTab('egresos') + '</main>' + renderFab('egresos');
    return '<main>' + renderRefreshBar() + renderRrhhTab() + '</main>';
  }

  function renderSetupHero() {
    return (
      '<div class="setup-hero">' +
        '<div class="logo-lg">KI</div>' +
        '<h2>Bienvenido a KI-PITAL</h2>' +
        '<p>Para que todo el equipo vea los mismos datos, conecta esta app a tu repositorio de GitHub.</p>' +
        '<div style="margin-top:22px;"><button class="btn btn-primary" data-action="open-config">Conectar ahora</button></div>' +
      '</div>'
    );
  }

  function renderRefreshBar() {
    var syncing = state.syncStatus === 'syncing';
    return (
      '<div style="margin-bottom:12px;">' +
        '<button type="button" class="btn btn-secondary" data-action="refresh" ' + (syncing ? 'disabled' : '') + '>' +
          (syncing ? '<span class="spinner"></span> Actualizando…' : '&#8635; Actualizar') +
        '</button>' +
      '</div>'
    );
  }

  function renderInstallCard() {
    if (isStandaloneApp()) return '';
    if (state.deferredInstallPrompt) {
      return (
        '<div class="card" style="text-align:center;padding:18px;cursor:pointer;background:linear-gradient(135deg,rgba(242,181,68,.12),transparent);" data-action="install-app">' +
          '<div style="font-size:28px;">&#128241;</div>' +
          '<div style="font-weight:700;margin-top:6px;">Instalar la app</div>' +
          '<div style="color:var(--text-dim);font-size:12.5px;margin-top:2px;">Agrégala a tu pantalla de inicio para abrirla como una app</div>' +
        '</div>'
      );
    }
    if (isIosDevice()) {
      return (
        '<div class="card" style="text-align:center;padding:18px;">' +
          '<div style="font-size:28px;">&#128241;</div>' +
          '<div style="font-weight:700;margin-top:6px;">Instalar en iPhone</div>' +
          '<div style="color:var(--text-dim);font-size:12.5px;margin-top:2px;">Toca el botón Compartir &#8593; de Safari y elige "Agregar a pantalla de inicio"</div>' +
        '</div>'
      );
    }
    return '';
  }

  // ---------- Inicio ----------

  function renderInicioTab() {
    var ingresos = filterByPeriod(state.data.ingresos.value || []);
    var egresos = filterByPeriod(state.data.egresos.value || []);
    var totalIn = ingresos.reduce(function (s, g) { return s + (Number(g.monto) || 0); }, 0);
    var totalOut = egresos.reduce(function (s, g) { return s + (Number(g.monto) || 0); }, 0);
    var balance = totalIn - totalOut;

    var html = renderPeriodPicker();
    html += (
      '<div class="stat-row">' +
        '<div class="stat-card ingreso"><div class="amount">' + escapeHtml(formatMoney(totalIn)) + '</div><div class="label">Ingresos</div></div>' +
        '<div class="stat-card egreso"><div class="amount">' + escapeHtml(formatMoney(totalOut)) + '</div><div class="label">Egresos</div></div>' +
        '<div class="stat-card balance"><div class="amount">' + escapeHtml(formatMoney(balance)) + '</div><div class="label">Balance</div></div>' +
      '</div>'
    );
    html += (
      '<div class="card" style="text-align:center;padding:18px;cursor:pointer;" data-action="tab" data-tab="ingresos">' +
        '<div style="font-size:28px;">&#128176;</div>' +
        '<div style="font-weight:700;margin-top:6px;">Ingresos</div>' +
        '<div style="color:var(--text-dim);font-size:12.5px;margin-top:2px;">Tarjetas, transferencias y efectivo</div>' +
      '</div>' +
      '<div class="card" style="text-align:center;padding:18px;cursor:pointer;" data-action="tab" data-tab="egresos">' +
        '<div style="font-size:28px;">&#128179;</div>' +
        '<div style="font-weight:700;margin-top:6px;">Egresos</div>' +
        '<div style="color:var(--text-dim);font-size:12.5px;margin-top:2px;">Alquiler, salarios, servicios e insumos</div>' +
      '</div>' +
      '<div class="card" style="text-align:center;padding:18px;cursor:pointer;" data-action="tab" data-tab="rrhh">' +
        '<div style="font-size:28px;">&#128101;</div>' +
        '<div style="font-weight:700;margin-top:6px;">RRHH</div>' +
        '<div style="color:var(--text-dim);font-size:12.5px;margin-top:2px;">Colaboradores y procesamiento de nómina</div>' +
      '</div>'
    );
    html += renderInstallCard();
    return html;
  }

  function renderPeriodPicker() {
    return (
      '<div class="card">' +
        '<label style="margin-top:0;">Período</label>' +
        '<div class="period-row">' +
          '<div><label style="margin-top:0;">Desde</label><input id="period-desde" type="date" value="' + escapeHtml(state.period.desde || '') + '"/></div>' +
          '<div><label style="margin-top:0;">Hasta</label><input id="period-hasta" type="date" value="' + escapeHtml(state.period.hasta || '') + '"/></div>' +
        '</div>' +
        '<div class="quick-periods">' +
          quickChip('today', 'Hoy') + quickChip('month', 'Este mes') + quickChip('lastmonth', 'Mes pasado') + quickChip('year', 'Este año') + quickChip('all', 'Todo') +
        '</div>' +
      '</div>'
    );
  }

  function quickChip(kind, label) {
    return '<button type="button" class="chip ' + (state.quickPeriod === kind ? 'active' : '') + '" data-action="quick-period" data-range="' + kind + '">' + label + '</button>';
  }

  // ---------- Ingresos / Egresos (tab) ----------

  function renderMovTab(kind) {
    var raw = state.data[kind].value || [];
    var filtered = filterByPeriod(raw).slice().sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
    var total = filtered.reduce(function (s, g) { return s + (Number(g.monto) || 0); }, 0);
    var porTipo = groupBy(filtered, 'tipo');

    var html = renderPeriodPicker();
    html += (
      '<div class="summary-total" style="padding-top:6px;">' +
        '<div class="amount">' + escapeHtml(formatMoney(total)) + '</div>' +
        '<div class="label">Total de ' + (kind === 'ingresos' ? 'ingresos' : 'egresos') + ' en el período</div>' +
      '</div>'
    );

    if (porTipo.length) {
      html += '<div class="card"><label style="margin-top:0;">Por tipo</label>';
      html += porTipo.map(function (r) {
        return '<div class="report-row"><div><div class="name">' + escapeHtml(r.name) + '</div><div class="count">' + r.count + ' registro' + (r.count === 1 ? '' : 's') + '</div></div><div class="amt">' + escapeHtml(formatMoney(r.total)) + '</div></div>';
      }).join('');
      html += '</div>';
    }

    if (!raw.length) {
      html += '<div class="empty-state"><span class="big">&#128221;</span>Aún no hay ' + (kind === 'ingresos' ? 'ingresos' : 'egresos') + ' registrados.<br/>Toca el botón + para agregar el primero.</div>';
      return html;
    }
    if (!filtered.length) {
      html += '<div class="empty-state"><span class="big">&#128269;</span>No hay registros en este período.</div>';
      return html;
    }

    html += '<div class="card">';
    html += filtered.map(function (g) { return renderMovItem(kind, g); }).join('');
    html += '</div>';
    return html;
  }

  function renderMovItem(kind, g) {
    return (
      '<div class="item-row" data-action="edit-mov" data-kind="' + kind + '" data-id="' + escapeHtml(g.id) + '">' +
        '<div class="left">' +
          '<div class="title">' + escapeHtml(g.tipo) + '</div>' +
          '<div class="meta">' + escapeHtml(formatDateDisplay(g.fecha)) + (g.nota ? ' · ' + escapeHtml(g.nota) : '') + '</div>' +
        '</div>' +
        '<div class="monto ' + (kind === 'ingresos' ? 'ingreso' : 'egreso') + '">' + escapeHtml(formatMoney(g.monto)) + '</div>' +
      '</div>'
    );
  }

  function renderFab(kind) {
    return '<button class="fab" data-action="open-mov-new" data-kind="' + kind + '" title="Nuevo">+</button>';
  }

  // ---------- RRHH ----------

  function renderRrhhTab() {
    var html = (
      '<div class="segmented">' +
        '<button class="' + (state.rrhhTab === 'colaboradores' ? 'active' : '') + '" data-action="rrhh-tab" data-rt="colaboradores">Colaboradores</button>' +
        '<button class="' + (state.rrhhTab === 'nomina' ? 'active' : '') + '" data-action="rrhh-tab" data-rt="nomina">Nómina</button>' +
      '</div>'
    );
    html += state.rrhhTab === 'colaboradores' ? renderColaboradoresView() : renderNominaView();
    return html;
  }

  function renderColaboradoresView() {
    var list = (state.data.colaboradores.value || []).slice().sort(function (a, b) { return (a.nombre || '').localeCompare(b.nombre || ''); });
    var html = '<div class="btn-row" style="margin-bottom:14px;"><button type="button" class="btn btn-primary" data-action="open-colab-new">+ Colaborador</button></div>';
    if (!list.length) {
      html += '<div class="empty-state"><span class="big">&#128100;</span>Aún no hay colaboradores. Toca "+ Colaborador" para agregar el primero.</div>';
      return html;
    }
    html += '<div class="card">';
    html += list.map(renderColabItem).join('');
    html += '</div>';
    return html;
  }

  function renderColabItem(c) {
    var activo = c.estado !== 'inactivo';
    return (
      '<div class="item-row" data-action="edit-colab" data-id="' + escapeHtml(c.id) + '">' +
        '<div class="left">' +
          '<div class="title">' + escapeHtml(c.nombre) + '</div>' +
          '<div class="meta">' + escapeHtml(c.puesto || '') + ' · Ingreso: ' + escapeHtml(formatDateDisplay(c.fechaIngreso)) + '</div>' +
          '<span class="badge ' + (activo ? 'on' : 'off') + '">' + (activo ? 'Activo' : 'Inactivo') + '</span>' +
        '</div>' +
        '<div class="monto">' + escapeHtml(formatMoney(c.salario)) + '</div>' +
      '</div>'
    );
  }

  function renderNominaView() {
    var planillas = (state.data.nomina.value || []).slice().sort(function (a, b) {
      return (b.periodoMes || '').localeCompare(a.periodoMes || '') || (b.fechaPago || '').localeCompare(a.fechaPago || '');
    });
    var html = '<div class="btn-row" style="margin-bottom:14px;">' +
      '<button type="button" class="btn btn-primary" data-action="open-planilla-new">+ Generar planilla</button>' +
      '<button type="button" class="btn btn-secondary" data-action="open-nomina-config" title="Configurar parámetros">&#9881; Parámetros</button>' +
    '</div>';

    if (!planillas.length) {
      html += '<div class="empty-state"><span class="big">&#128203;</span>Aún no se ha procesado ninguna planilla.</div>';
      return html;
    }

    html += '<div class="card">';
    html += planillas.map(function (p) {
      return (
        '<div class="item-row" data-action="view-planilla" data-id="' + escapeHtml(p.id) + '">' +
          '<div class="left">' +
            '<div class="title">' + escapeHtml(monthLabel(p.periodoMes)) + '</div>' +
            '<div class="meta">Pago: ' + escapeHtml(formatDateDisplay(p.fechaPago)) + ' · ' + p.detalle.length + ' colaborador' + (p.detalle.length === 1 ? '' : 'es') + '</div>' +
            '<span class="badge ' + (p.registradoEnEgresos ? 'on' : '') + '">' + (p.registradoEnEgresos ? 'Registrada en egresos' : 'Sin registrar en egresos') + '</span>' +
          '</div>' +
          '<div class="monto">' + escapeHtml(formatMoney(p.totalNeto)) + '</div>' +
        '</div>'
      );
    }).join('');
    html += '</div>';
    return html;
  }

  // ---------- Pantallas: formularios ----------

  function renderScreen() {
    if (state.screen === 'mov-form') return renderMovFormScreen();
    if (state.screen === 'colab-form') return renderColabFormScreen();
    if (state.screen === 'nomina-config') return renderNominaConfigScreen();
    if (state.screen === 'planilla-form') return renderPlanillaFormScreen();
    if (state.screen === 'planilla-detail') return renderPlanillaDetailScreen();
    if (state.screen === 'config') return renderConfigScreen();
    return '';
  }

  function renderMovFormScreen() {
    var kind = state.movKind;
    var list = state.data[kind].value || [];
    var editing = state.editingId ? list.find(function (g) { return g.id === state.editingId; }) : null;
    var title = (editing ? 'Editar ' : 'Nuevo ') + labelFor(kind);
    var today = toISODate(new Date());
    var tipos = tiposFor(kind);

    var options = tipos.map(function (t) {
      var sel = editing ? (editing.tipo === t ? 'selected' : '') : '';
      return '<option value="' + escapeHtml(t) + '" ' + sel + '>' + escapeHtml(t) + '</option>';
    }).join('');

    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          '<button class="icon-btn" data-action="close-screen">&larr;</button>' +
          '<h2>' + title + '</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<form data-form="mov">' +
            '<label for="m-fecha">Fecha</label>' +
            '<input id="m-fecha" name="fecha" type="date" required value="' + escapeHtml(editing ? editing.fecha : today) + '"/>' +

            '<label for="m-tipo">Tipo de ' + labelFor(kind) + '</label>' +
            '<select id="m-tipo" name="tipo">' + options + '</select>' +

            '<label for="m-monto">Monto (₡)</label>' +
            '<input id="m-monto" name="monto" type="number" step="0.01" min="0.01" required inputmode="decimal" placeholder="0.00" value="' + (editing ? editing.monto : '') + '"/>' +

            '<label for="m-nota">Nota (opcional)</label>' +
            '<input id="m-nota" name="nota" type="text" placeholder="Detalle adicional" value="' + escapeHtml(editing ? (editing.nota || '') : '') + '"/>' +

            '<div class="btn-row" style="margin-top:22px;">' +
              '<button type="submit" class="btn btn-primary">Guardar</button>' +
            '</div>' +
            (editing ? '<div class="btn-row" style="margin-top:10px;"><button type="button" class="btn btn-danger" data-action="delete-mov" data-kind="' + kind + '" data-id="' + escapeHtml(editing.id) + '">Eliminar</button></div>' : '') +
          '</form>' +
        '</div>' +
      '</div>'
    );
  }

  function renderColabFormScreen() {
    var editing = state.editingId ? (state.data.colaboradores.value || []).find(function (c) { return c.id === state.editingId; }) : null;
    var title = editing ? 'Editar colaborador' : 'Nuevo colaborador';
    var activo = editing ? editing.estado !== 'inactivo' : true;
    var tipoPagoOpts = TIPO_PAGO_OPTS.map(function (t) {
      var sel = editing ? (editing.tipoPago === t ? 'selected' : '') : (t === 'Mensual' ? 'selected' : '');
      return '<option value="' + t + '" ' + sel + '>' + t + '</option>';
    }).join('');

    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          '<button class="icon-btn" data-action="close-screen">&larr;</button>' +
          '<h2>' + title + '</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<form data-form="colab">' +
            '<label for="c-nombre">Nombre completo</label>' +
            '<input id="c-nombre" name="nombre" type="text" required placeholder="Ej: María Fernández" value="' + escapeHtml(editing ? editing.nombre : '') + '"/>' +

            '<label for="c-cedula">Cédula</label>' +
            '<input id="c-cedula" name="cedula" type="text" placeholder="0-0000-0000" value="' + escapeHtml(editing ? (editing.cedula || '') : '') + '"/>' +

            '<label for="c-telefono">Teléfono</label>' +
            '<input id="c-telefono" name="telefono" type="tel" placeholder="8888-8888" value="' + escapeHtml(editing ? (editing.telefono || '') : '') + '"/>' +

            '<label for="c-email">Correo electrónico</label>' +
            '<input id="c-email" name="email" type="email" placeholder="correo@ejemplo.com" value="' + escapeHtml(editing ? (editing.email || '') : '') + '"/>' +

            '<label for="c-direccion">Dirección</label>' +
            '<input id="c-direccion" name="direccion" type="text" placeholder="Dirección exacta" value="' + escapeHtml(editing ? (editing.direccion || '') : '') + '"/>' +

            '<label for="c-puesto">Puesto</label>' +
            '<input id="c-puesto" name="puesto" type="text" required placeholder="Ej: Mesero, Cocinero, Cajera…" value="' + escapeHtml(editing ? editing.puesto : '') + '"/>' +

            '<label for="c-salario">Salario bruto mensual (₡)</label>' +
            '<input id="c-salario" name="salario" type="number" step="0.01" min="0.01" required inputmode="decimal" placeholder="0.00" value="' + (editing ? editing.salario : '') + '"/>' +

            '<label for="c-tipopago">Tipo de pago</label>' +
            '<select id="c-tipopago" name="tipoPago">' + tipoPagoOpts + '</select>' +

            '<label for="c-fecha-ingreso">Fecha de ingreso</label>' +
            '<input id="c-fecha-ingreso" name="fechaIngreso" type="date" required value="' + escapeHtml(editing ? editing.fechaIngreso : '') + '"/>' +

            '<div class="checkbox-row">' +
              '<input id="c-estado" name="estado" type="checkbox" ' + (activo ? 'checked' : '') + '/>' +
              '<label for="c-estado">Colaborador activo</label>' +
            '</div>' +

            '<div class="btn-row" style="margin-top:22px;">' +
              '<button type="submit" class="btn btn-primary">Guardar</button>' +
            '</div>' +
            (editing ? '<div class="btn-row" style="margin-top:10px;"><button type="button" class="btn btn-danger" data-action="delete-colab" data-id="' + escapeHtml(editing.id) + '">Eliminar colaborador</button></div>' : '') +
          '</form>' +
        '</div>' +
      '</div>'
    );
  }

  function renderNominaConfigScreen() {
    var cfg = currentNominaConfig();
    var tramos = cfg.tramos || DEFAULT_NOMINA_CONFIG.tramos;
    var rows = '';
    for (var i = 0; i < 5; i++) {
      var t = tramos[i] || DEFAULT_NOMINA_CONFIG.tramos[i];
      if (i < 4) {
        rows += (
          '<div class="tramos-row">' +
            '<span class="lbl">Tramo ' + (i + 1) + '</span>' +
            '<input name="tramo' + i + '_hasta" type="number" step="1" placeholder="Hasta ₡" value="' + (t.hasta != null ? t.hasta : '') + '"/>' +
            '<input name="tramo' + i + '_tasa" type="number" step="0.01" placeholder="Tasa %" value="' + t.tasa + '"/>' +
          '</div>'
        );
      } else {
        rows += (
          '<div class="tramos-row">' +
            '<span class="lbl">En adelante</span>' +
            '<input type="text" value="Sin límite" disabled/>' +
            '<input name="tramo' + i + '_tasa" type="number" step="0.01" placeholder="Tasa %" value="' + t.tasa + '"/>' +
          '</div>'
        );
      }
    }

    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          '<button class="icon-btn" data-action="close-screen">&larr;</button>' +
          '<h2>Parámetros de nómina</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<p style="color:var(--text-dim);font-size:12.5px;">Estos porcentajes cambian por ley cada cierto tiempo en Costa Rica. Valores de referencia vigentes para 2026; ajústalos si cambian.</p>' +
          '<form data-form="nomina-config">' +
            '<label for="nc-ccss">CCSS trabajador (%)</label>' +
            '<input id="nc-ccss" name="ccssTrabajador" type="number" step="0.01" min="0" required value="' + cfg.ccssTrabajador + '"/>' +
            '<div class="field-hint">Rebajo obligatorio al salario del colaborador (SEM + IVM + Banco Popular).</div>' +

            '<label for="nc-patronal">Cargas sociales patronales (%)</label>' +
            '<input id="nc-patronal" name="cargasPatronales" type="number" step="0.01" min="0" required value="' + cfg.cargasPatronales + '"/>' +
            '<div class="field-hint">Lo que la empresa aporta además del salario bruto (CCSS patronal, FODESAF, INA, IMAS, Banco Popular, etc. No incluye INS, que varía según riesgo).</div>' +

            '<label style="margin-top:20px;">Tramos de renta (impuesto al salario, mensual)</label>' +
            rows +

            '<div class="btn-row" style="margin-top:22px;">' +
              '<button type="submit" class="btn btn-primary">Guardar</button>' +
            '</div>' +
            '<div class="btn-row" style="margin-top:10px;"><button type="button" class="btn btn-secondary" data-action="reset-nomina-config-defaults">Restaurar valores 2026</button></div>' +
          '</form>' +
        '</div>' +
      '</div>'
    );
  }

  function renderPlanillaFormScreen() {
    var draft = state.planillaDraft;
    if (!draft) return '';
    var cfg = currentNominaConfig();

    var filasHtml = draft.filas.map(function (f, idx) {
      var calc = computePlanillaFila(f, cfg);
      return (
        '<div class="planilla-emp-row">' +
          '<div class="name">' + escapeHtml(f.nombre) + '</div>' +
          '<div class="puesto">' + escapeHtml(f.puesto || '') + '</div>' +
          '<div class="planilla-grid">' +
            '<div><label style="margin-top:0;">Salario base (₡)</label><input id="pf-base-' + idx + '" data-idx="' + idx + '" data-field="salarioBase" type="number" step="0.01" value="' + f.salarioBase + '"/></div>' +
            '<div><label style="margin-top:0;">Bonos / horas extra (₡)</label><input id="pf-bonos-' + idx + '" data-idx="' + idx + '" data-field="bonos" type="number" step="0.01" value="' + f.bonos + '"/></div>' +
            '<div><label style="margin-top:0;">Otras deducciones (₡)</label><input id="pf-otras-' + idx + '" data-idx="' + idx + '" data-field="otrasDeducciones" type="number" step="0.01" value="' + f.otrasDeducciones + '"/></div>' +
          '</div>' +
          '<div class="planilla-calc">' +
            '<div class="row"><span>Salario bruto</span><span>' + escapeHtml(formatMoney(calc.salarioBruto)) + '</span></div>' +
            '<div class="row"><span>CCSS trabajador</span><span>-' + escapeHtml(formatMoney(calc.ccssTrabajador)) + '</span></div>' +
            '<div class="row"><span>Renta</span><span>-' + escapeHtml(formatMoney(calc.renta)) + '</span></div>' +
            '<div class="row"><span>Otras deducciones</span><span>-' + escapeHtml(formatMoney(calc.otrasDeducciones)) + '</span></div>' +
            '<div class="row neto"><span>Neto a pagar</span><span>' + escapeHtml(formatMoney(calc.salarioNeto)) + '</span></div>' +
            '<div class="row"><span>Cargas patronales</span><span>' + escapeHtml(formatMoney(calc.cargasPatronales)) + '</span></div>' +
            '<div class="row"><span>Costo total patronal</span><span>' + escapeHtml(formatMoney(calc.costoTotal)) + '</span></div>' +
          '</div>' +
          '<div class="btn-row" style="margin-top:10px;"><button type="button" class="small-btn" data-action="planilla-remove-fila" data-idx="' + idx + '">Quitar de esta planilla</button></div>' +
        '</div>'
      );
    }).join('');

    var totals = draft.filas.map(function (f) { return computePlanillaFila(f, cfg); }).reduce(function (acc, d) {
      acc.bruto += d.salarioBruto; acc.neto += d.salarioNeto; acc.cargas += d.cargasPatronales; acc.costo += d.costoTotal;
      return acc;
    }, { bruto: 0, neto: 0, cargas: 0, costo: 0 });

    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          '<button class="icon-btn" data-action="close-screen">&larr;</button>' +
          '<h2>Generar planilla</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<div class="card">' +
            '<label style="margin-top:0;">Período (mes)</label>' +
            '<input id="pf-periodo" type="month" value="' + escapeHtml(draft.periodoMes) + '"/>' +
            '<label>Fecha de pago</label>' +
            '<input id="pf-fechapago" type="date" value="' + escapeHtml(draft.fechaPago) + '"/>' +
          '</div>' +
          (draft.filas.length ? filasHtml : '<div class="empty-state"><span class="big">&#128100;</span>No hay colaboradores activos para este período.</div>') +
          (draft.filas.length ? (
            '<div class="card">' +
              '<div class="grand-total-row"><span>Total bruto</span><span>' + escapeHtml(formatMoney(totals.bruto)) + '</span></div>' +
              '<div class="grand-total-row" style="border-top:none;padding-top:4px;"><span>Total neto a pagar</span><span>' + escapeHtml(formatMoney(totals.neto)) + '</span></div>' +
              '<div class="grand-total-row" style="border-top:none;padding-top:4px;"><span>Total cargas patronales</span><span>' + escapeHtml(formatMoney(totals.cargas)) + '</span></div>' +
              '<div class="grand-total-row" style="border-top:none;padding-top:4px;"><span>Costo total patronal</span><span>' + escapeHtml(formatMoney(totals.costo)) + '</span></div>' +
            '</div>' +
            '<div class="btn-row"><button type="button" class="btn btn-primary" data-action="save-planilla">Guardar planilla</button></div>'
          ) : '') +
        '</div>' +
      '</div>'
    );
  }

  function renderPlanillaDetailScreen() {
    var p = findPlanilla(state.editingId);
    if (!p) return '';
    var rows = p.detalle.map(function (d) {
      return (
        '<div class="planilla-emp-row">' +
          '<div class="name">' + escapeHtml(d.nombre) + '</div>' +
          '<div class="puesto">' + escapeHtml(d.puesto || '') + '</div>' +
          '<div class="planilla-calc">' +
            '<div class="row"><span>Salario base</span><span>' + escapeHtml(formatMoney(d.salarioBase)) + '</span></div>' +
            (d.bonos ? '<div class="row"><span>Bonos / extras</span><span>' + escapeHtml(formatMoney(d.bonos)) + '</span></div>' : '') +
            '<div class="row"><span>Salario bruto</span><span>' + escapeHtml(formatMoney(d.salarioBruto)) + '</span></div>' +
            '<div class="row"><span>CCSS trabajador</span><span>-' + escapeHtml(formatMoney(d.ccssTrabajador)) + '</span></div>' +
            '<div class="row"><span>Renta</span><span>-' + escapeHtml(formatMoney(d.renta)) + '</span></div>' +
            (d.otrasDeducciones ? '<div class="row"><span>Otras deducciones</span><span>-' + escapeHtml(formatMoney(d.otrasDeducciones)) + '</span></div>' : '') +
            '<div class="row neto"><span>Neto pagado</span><span>' + escapeHtml(formatMoney(d.salarioNeto)) + '</span></div>' +
            '<div class="row"><span>Cargas patronales</span><span>' + escapeHtml(formatMoney(d.cargasPatronales)) + '</span></div>' +
            '<div class="row"><span>Costo total patronal</span><span>' + escapeHtml(formatMoney(d.costoTotal)) + '</span></div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          '<button class="icon-btn" data-action="close-screen">&larr;</button>' +
          '<h2>' + escapeHtml(monthLabel(p.periodoMes)) + '</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<div class="card">' +
            '<div class="report-row"><div class="name">Fecha de pago</div><div class="amt">' + escapeHtml(formatDateDisplay(p.fechaPago)) + '</div></div>' +
            '<div class="report-row"><div class="name">Colaboradores</div><div class="amt">' + p.detalle.length + '</div></div>' +
          '</div>' +
          rows +
          '<div class="card">' +
            '<div class="grand-total-row"><span>Total bruto</span><span>' + escapeHtml(formatMoney(p.totalBruto)) + '</span></div>' +
            '<div class="grand-total-row" style="border-top:none;padding-top:4px;"><span>Total CCSS trabajador</span><span>' + escapeHtml(formatMoney(p.totalCcssTrabajador)) + '</span></div>' +
            '<div class="grand-total-row" style="border-top:none;padding-top:4px;"><span>Total renta</span><span>' + escapeHtml(formatMoney(p.totalRenta)) + '</span></div>' +
            '<div class="grand-total-row" style="border-top:none;padding-top:4px;"><span>Total neto pagado</span><span>' + escapeHtml(formatMoney(p.totalNeto)) + '</span></div>' +
            '<div class="grand-total-row" style="border-top:none;padding-top:4px;"><span>Total cargas patronales</span><span>' + escapeHtml(formatMoney(p.totalCargasPatronales)) + '</span></div>' +
            '<div class="grand-total-row" style="border-top:none;padding-top:4px;"><span>Costo total patronal</span><span>' + escapeHtml(formatMoney(p.totalCostoPatronal)) + '</span></div>' +
          '</div>' +
          '<div class="btn-row"><button type="button" class="btn btn-secondary" data-action="download-planilla-pdf" data-id="' + escapeHtml(p.id) + '">&#128196; Descargar / compartir PDF</button></div>' +
          '<div class="btn-row" style="margin-top:10px;">' +
            (p.registradoEnEgresos
              ? '<button type="button" class="btn btn-secondary" disabled>Ya registrada en Egresos</button>'
              : '<button type="button" class="btn btn-primary" data-action="registrar-planilla-egresos" data-id="' + escapeHtml(p.id) + '">Registrar en Egresos</button>') +
          '</div>' +
          '<div class="btn-row" style="margin-top:18px;"><button type="button" class="btn btn-danger" data-action="delete-planilla" data-id="' + escapeHtml(p.id) + '">Eliminar planilla</button></div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderConfigScreen() {
    var cfg = state.config || {};
    return (
      '<div class="screen">' +
        '<div class="screen-header">' +
          (state.config ? '<button class="icon-btn" data-action="close-screen">&larr;</button>' : '<div style="width:36px;"></div>') +
          '<h2>Configuración</h2>' +
        '</div>' +
        '<div class="screen-body">' +
          '<p style="color:var(--text-dim);font-size:13px;">Conecta esta app al repositorio de GitHub donde se guardan los datos de KI-PITAL. Solo se hace una vez por dispositivo.</p>' +

          '<div class="card">' +
            '<label style="margin-top:0;">¿Alguien del equipo ya te compartió un código de configuración?</label>' +
            '<input id="c-paste" type="text" placeholder="Pega aquí el código"/>' +
            '<div class="btn-row" style="margin-top:10px;">' +
              '<button type="button" class="btn btn-primary" data-action="paste-config" ' + (state.configVerifying ? 'disabled' : '') + '>Usar este código y conectar</button>' +
            '</div>' +
          '</div>' +
          '<p style="color:var(--text-dim);font-size:12px;text-align:center;margin:-6px 0 18px;">— o completa los datos manualmente —</p>' +

          '<form data-form="config">' +
            '<label for="cf-owner">Usuario u organización de GitHub</label>' +
            '<input id="cf-owner" name="owner" type="text" required placeholder="Ej: dsolismendez23-design" value="' + escapeHtml(cfg.owner || '') + '"/>' +

            '<label for="cf-repo">Repositorio</label>' +
            '<input id="cf-repo" name="repo" type="text" required placeholder="Ej: kipital-app" value="' + escapeHtml(cfg.repo || '') + '"/>' +

            '<label for="cf-branch">Rama</label>' +
            '<input id="cf-branch" name="branch" type="text" placeholder="main" value="' + escapeHtml(cfg.branch || 'main') + '"/>' +

            '<label for="cf-token">Token de acceso personal</label>' +
            '<input id="cf-token" name="token" type="' + (state.showToken ? 'text' : 'password') + '" required placeholder="ghp_..." value="' + escapeHtml(cfg.token || '') + '"/>' +
            '<button type="button" class="link-btn" data-action="toggle-token">' + (state.showToken ? 'Ocultar token' : 'Mostrar token') + '</button>' +
            '<div class="field-hint">El token debe ser un "fine-grained token" con permiso de Contents (lectura y escritura) limitado a este repositorio.</div>' +

            (state.configError ? '<div class="toast error" style="position:static;transform:none;margin-top:14px;width:100%;">' + escapeHtml(state.configError) + '</div>' : '') +

            '<div class="btn-row" style="margin-top:22px;">' +
              '<button type="submit" class="btn btn-primary" ' + (state.configVerifying ? 'disabled' : '') + '>' +
                (state.configVerifying ? '<span class="spinner"></span> Verificando…' : 'Guardar y conectar') +
              '</button>' +
            '</div>' +
          '</form>' +
          (state.config ? (
            '<div class="btn-row" style="margin-top:26px;"><button type="button" class="btn btn-secondary" data-action="copy-config">Copiar configuración para otro dispositivo</button></div>' +
            '<div class="field-hint" style="text-align:center;">Comparte ese código solo por un canal seguro (WhatsApp, etc.). Da acceso completo a los datos de este repositorio.</div>' +
            '<div class="btn-row" style="margin-top:18px;"><button type="button" class="btn btn-secondary btn-danger" data-action="reset-config">Desconectar este dispositivo</button></div>'
          ) : '') +
        '</div>' +
      '</div>'
    );
  }

  function renderToast() {
    if (!state.toast) return '';
    return '<div class="toast ' + (state.toast.isError ? 'error' : '') + '">' + escapeHtml(state.toast.msg) + '</div>';
  }

  // ---------- Delegación de eventos ----------

  appEl.addEventListener('click', function (e) {
    var target = e.target.closest('[data-action]');
    if (!target) return;
    var action = target.dataset.action;
    if (action === 'tab') switchTab(target.dataset.tab);
    else if (action === 'rrhh-tab') switchRrhhTab(target.dataset.rt);
    else if (action === 'open-mov-new') openNewMovForm(target.dataset.kind);
    else if (action === 'edit-mov') openEditMovForm(target.dataset.kind, target.dataset.id);
    else if (action === 'delete-mov') deleteMov(target.dataset.kind, target.dataset.id);
    else if (action === 'open-colab-new') openNewColabForm();
    else if (action === 'edit-colab') openEditColabForm(target.dataset.id);
    else if (action === 'delete-colab') deleteColab(target.dataset.id);
    else if (action === 'open-nomina-config') openNominaConfigScreen();
    else if (action === 'reset-nomina-config-defaults') restoreNominaConfigDefaults();
    else if (action === 'open-planilla-new') openNewPlanillaForm();
    else if (action === 'planilla-remove-fila') removeFilaPlanilla(parseInt(target.dataset.idx, 10));
    else if (action === 'save-planilla') savePlanilla();
    else if (action === 'view-planilla') viewPlanilla(target.dataset.id);
    else if (action === 'delete-planilla') deletePlanilla(target.dataset.id);
    else if (action === 'download-planilla-pdf') downloadOrSharePlanillaPdf(target.dataset.id);
    else if (action === 'registrar-planilla-egresos') registrarPlanillaEnEgresos(target.dataset.id);
    else if (action === 'close-screen') closeScreen();
    else if (action === 'open-config') openConfig();
    else if (action === 'refresh') refreshCurrentView();
    else if (action === 'quick-period') setQuickPeriod(target.dataset.range);
    else if (action === 'reset-config') resetConfig();
    else if (action === 'toggle-token') toggleTokenVisibility();
    else if (action === 'copy-config') copyConfigForSharing();
    else if (action === 'paste-config') usePastedConfig();
    else if (action === 'install-app') installApp();
  });

  appEl.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    var fd = new FormData(form);
    var type = form.dataset.form;
    if (type === 'mov') onSubmitMovForm(fd);
    else if (type === 'config') onSubmitConfigForm(fd);
    else if (type === 'colab') onSubmitColabForm(fd);
    else if (type === 'nomina-config') onSubmitNominaConfigForm(fd);
  });

  appEl.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id === 'period-desde') { state.period.desde = e.target.value; state.quickPeriod = 'custom'; render(); }
    else if (id === 'period-hasta') { state.period.hasta = e.target.value; state.quickPeriod = 'custom'; render(); }
    else if (e.target.dataset && e.target.dataset.field && state.planillaDraft) {
      var idx = parseInt(e.target.dataset.idx, 10);
      var field = e.target.dataset.field;
      if (state.planillaDraft.filas[idx]) {
        state.planillaDraft.filas[idx][field] = parseFloat(e.target.value) || 0;
        render();
      }
    } else if (id === 'pf-fechapago' && state.planillaDraft) {
      state.planillaDraft.fechaPago = e.target.value;
    }
  });

  appEl.addEventListener('change', function (e) {
    if (e.target.id === 'pf-periodo') planillaPeriodoChanged(e.target.value);
  });

  // ---------- Arranque ----------

  if (!state.config) state.screen = 'config';
  render();
  if (state.config) loadInitialData();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
