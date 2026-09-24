(function () {
  'use strict';

  var doc = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(pointer: fine)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  /* ================= i18n ================= */
  var LANGS = ['en', 'ja', 'es', 'fr', 'de'];
  var lang = pickLang();
  var listeners = [];

  function pickLang() {
    var q = new URLSearchParams(location.search).get('lang');
    if (q && LANGS.indexOf(q) > -1) return q;
    var saved = store.get('honmaru-lang');
    if (saved && LANGS.indexOf(saved) > -1) return saved;
    var nav = (navigator.languages || [navigator.language || 'en']);
    for (var i = 0; i < nav.length; i++) {
      var base = String(nav[i]).slice(0, 2).toLowerCase();
      if (LANGS.indexOf(base) > -1) return base;
    }
    return 'en';
  }
  function t(key, vars) {
    var dict = window.I18N[lang] || window.I18N.en;
    var v = dict[key] !== undefined ? dict[key] : window.I18N.en[key];
    if (typeof v === 'string' && vars) v = v.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? vars[k] : ''; });
    return v;
  }
  function applyLang() {
    doc.lang = lang;
    document.title = t('meta.title');
    var md = $('meta[name="description"]'); if (md) md.setAttribute('content', t('meta.desc'));
    $$('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    $$('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    $$('[data-i18n-placeholder]').forEach(function (el) { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
    $$('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
    $('#lang-select').value = lang;
    listeners.forEach(function (fn) { fn(); });
  }
  $('#lang-select').addEventListener('change', function (e) {
    lang = e.target.value;
    store.set('honmaru-lang', lang);
    var url = new URL(location.href); url.searchParams.set('lang', lang);
    history.replaceState(null, '', url);
    applyLang();
  });

  /* ================= theme ================= */
  var mqDark = window.matchMedia('(prefers-color-scheme: dark)');
  function isDark() {
    var t = doc.getAttribute('data-theme');
    return t ? t === 'dark' : mqDark.matches;
  }
  function onThemeChange() { themeListeners.forEach(function (fn) { fn(); }); }
  var themeListeners = [];
  $('#theme-toggle').addEventListener('click', function () {
    var next = isDark() ? 'light' : 'dark';
    doc.setAttribute('data-theme', next);
    store.set('honmaru-theme', next);
    onThemeChange();
  });
  if (mqDark.addEventListener) mqDark.addEventListener('change', onThemeChange);

  /* ================= nav + reveal ================= */
  var nav = $('#nav');
  function onScrollNav() { nav.classList.toggle('scrolled', window.scrollY > 12); }
  window.addEventListener('scroll', onScrollNav, { passive: true });
  onScrollNav();

  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: .08 });
    // stagger siblings that reveal together
    $$('.reveal').forEach(function (el) {
      var sibs = $$('.reveal', el.parentElement).filter(function (s) { return s.parentElement === el.parentElement; });
      el.style.setProperty('--d', (sibs.indexOf(el) * 0.08) + 's');
      io.observe(el);
    });
  } else {
    $$('.reveal').forEach(function (el) { el.classList.add('in'); });
  }
  $('#year').textContent = new Date().getFullYear();

  /* ================= hero: living org graph ================= */
  (function graph() {
    var canvas = $('#graph');
    var ctx = canvas.getContext('2d');
    var hero = $('.hero');
    var W, H, dpr, nodes = [], pulses = [], rgb, hot;
    var mouse = { x: -9999, y: -9999 };
    var running = true, raf = 0, last = 0, spawnAt = 0;
    var LINK = 150;

    function readColors() {
      var cs = getComputedStyle(doc);
      rgb = cs.getPropertyValue('--graph-node').trim() || '32,32,32';
      hot = cs.getPropertyValue('--graph-hot').trim() || '102,71,240';
    }
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = hero.clientWidth; H = hero.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var n = clamp(Math.round(W * H / 17000), 24, 80);
      nodes = [];
      for (var i = 0; i < n; i++) {
        nodes.push({
          x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - .5) * .18, vy: (Math.random() - .5) * .18,
          r: Math.random() < .12 ? 3.2 : 1.6 + Math.random() * 1.2,
          flash: 0
        });
      }
      pulses = [];
      if (reduceMotion) draw(0);
    }
    function neighbours(a) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var b = nodes[i]; if (b === a) continue;
        var dx = a.x - b.x, dy = a.y - b.y;
        if (dx * dx + dy * dy < LINK * LINK) out.push(b);
      }
      return out;
    }
    // A pulse is one message travelling AI → AI; it hops up to three times, then the
    // receiving node flashes — a decision card has landed.
    function spawn(from) {
      var a = from || nodes[(Math.random() * nodes.length) | 0];
      var ns = neighbours(a); if (!ns.length) return;
      pulses.push({ a: a, b: ns[(Math.random() * ns.length) | 0], t: 0, hops: from ? 0 : 2 + ((Math.random() * 2) | 0) });
    }
    function step(dt) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var dx = n.x - mouse.x, dy = n.y - mouse.y, d2 = dx * dx + dy * dy;
        if (d2 < 22000) { var f = (1 - d2 / 22000) * .06; n.vx += dx * f / 60; n.vy += dy * f / 60; }
        n.vx *= .985; n.vy *= .985;
        n.vx += (Math.random() - .5) * .006; n.vy += (Math.random() - .5) * .006;
        n.x += n.vx * dt * .06; n.y += n.vy * dt * .06;
        if (n.x < -20) n.x = W + 20; if (n.x > W + 20) n.x = -20;
        if (n.y < -20) n.y = H + 20; if (n.y > H + 20) n.y = -20;
        n.flash = Math.max(0, n.flash - dt / 900);
      }
      for (var j = pulses.length - 1; j >= 0; j--) {
        var p = pulses[j];
        p.t += dt / 700;
        if (p.t >= 1) {
          pulses.splice(j, 1);
          if (p.hops > 0) {
            var ns = neighbours(p.b).filter(function (x) { return x !== p.a; });
            if (ns.length) pulses.push({ a: p.b, b: ns[(Math.random() * ns.length) | 0], t: 0, hops: p.hops - 1 });
            else p.b.flash = 1;
          } else p.b.flash = 1;
        }
      }
    }
    function draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 1;
      for (var i = 0; i < nodes.length; i++) {
        var a = nodes[i];
        for (var k = i + 1; k < nodes.length; k++) {
          var b = nodes[k];
          var dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
          if (d2 > LINK * LINK) continue;
          var alpha = (1 - Math.sqrt(d2) / LINK) * .16;
          var mx = (a.x + b.x) / 2 - mouse.x, my = (a.y + b.y) / 2 - mouse.y;
          var near = mx * mx + my * my < 26000;
          ctx.strokeStyle = near ? 'rgba(' + hot + ',' + (alpha * 2.4) + ')' : 'rgba(' + rgb + ',' + alpha + ')';
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      for (var j = 0; j < pulses.length; j++) {
        var p = pulses[j];
        var x = p.a.x + (p.b.x - p.a.x) * p.t, y = p.a.y + (p.b.y - p.a.y) * p.t;
        ctx.strokeStyle = 'rgba(' + hot + ',.55)';
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(p.a.x, p.a.y); ctx.lineTo(x, y); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = 'rgba(' + hot + ',1)';
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 6.283); ctx.fill();
      }
      for (var m = 0; m < nodes.length; m++) {
        var n = nodes[m];
        if (n.flash > 0) {
          ctx.fillStyle = 'rgba(' + hot + ',' + (n.flash * .22) + ')';
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 14 * (1 - n.flash) + 4, 0, 6.283); ctx.fill();
        }
        ctx.fillStyle = n.flash > 0 ? 'rgba(' + hot + ',' + (.5 + n.flash * .5) + ')' : 'rgba(' + rgb + ',.34)';
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 6.283); ctx.fill();
      }
    }
    function loop(ts) {
      if (!running) return;
      var dt = Math.min(48, ts - (last || ts)); last = ts;
      if (ts > spawnAt) { spawn(); spawnAt = ts + 520 + Math.random() * 700; }
      step(dt); draw();
      raf = requestAnimationFrame(loop);
    }
    function start() { if (running || reduceMotion) return; running = true; last = 0; raf = requestAnimationFrame(loop); }
    function stop() { running = false; cancelAnimationFrame(raf); }

    readColors(); resize();
    themeListeners.push(function () { readColors(); if (reduceMotion) draw(); });
    var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(resize, 150); });
    hero.addEventListener('pointermove', function (e) {
      var r = canvas.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
    });
    hero.addEventListener('pointerleave', function () { mouse.x = mouse.y = -9999; });
    hero.addEventListener('click', function (e) {
      // a click fires a message from the nearest node
      if (e.target.closest('a,button,.phone')) return;
      var best = null, bd = 1e9;
      nodes.forEach(function (n) { var d = (n.x - mouse.x) * (n.x - mouse.x) + (n.y - mouse.y) * (n.y - mouse.y); if (d < bd) { bd = d; best = n; } });
      if (best) { best.flash = 1; for (var i = 0; i < 3; i++) spawn(best); pulses.forEach(function (p) { if (p.a === best) p.hops = 3; }); }
    });

    if (reduceMotion) { running = false; draw(); return; }
    running = false; start();
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { es[0].isIntersecting ? start() : stop(); }).observe(hero);
    }
    document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });
  })();

  /* ================= hero: swipeable decision cards ================= */
  (function cards() {
    var stackEl = $('#stack'), doneEl = $('#done'), countEl = $('#pending-count'), toast = $('#toast');
    var phone = $('#phone');
    var index = 0, toastTimer;
    var STRIPE = { DECISION: 'var(--pink)', CHOICE: 'var(--blue)', TASK: 'var(--line-strong)' };
    var TAG = { DECISION: 'tag-decision', CHOICE: 'tag-choice', TASK: 'tag-task', FYI: 'tag-fyi' };

    function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function render() {
      var list = t('cards');
      stackEl.innerHTML = '';
      var remaining = list.slice(index);
      countEl.textContent = remaining.length;
      doneEl.hidden = remaining.length > 0;
      $('.phone-actions').style.visibility = remaining.length ? 'visible' : 'hidden';
      remaining.slice(0, 3).reverse().forEach(function (c, i, arr) {
        var depth = arr.length - 1 - i;
        var el = document.createElement('article');
        el.className = 'dcard';
        el.dataset.depth = depth;
        el.style.setProperty('--stripe', STRIPE[c.kind] || 'var(--line-strong)');
        if (depth === 0) { el.tabIndex = 0; el.setAttribute('aria-label', c.title); }
        el.innerHTML =
          '<div class="mc-top"><span class="tag ' + TAG[c.kind] + '">' + c.kind + '</span><span class="mono mc-biz">' + esc(c.biz) + '</span></div>' +
          '<h3>' + esc(c.title) + '</h3><p>' + esc(c.body) + '</p>' +
          '<div class="route"><span class="ai-spark"></span><span>' + esc(c.from) + ' → ' + esc(t('how.yourAi')) + ' · ' + esc(c.reason) + '</span></div>' +
          '<span class="stamp yes">' + esc(t('phone.approve')) + '</span><span class="stamp no">' + esc(t('phone.reject')) + '</span>';
        stackEl.appendChild(el);
        if (depth === 0) bindDrag(el);
      });
    }
    function showToast(msg) {
      toast.textContent = msg; toast.classList.add('show');
      clearTimeout(toastTimer); toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2000);
    }
    function decide(dir) {
      var top = stackEl.querySelector('.dcard[data-depth="0"]');
      if (!top || top.dataset.leaving) return;
      top.dataset.leaving = '1';
      var card = t('cards')[index];
      top.classList.remove('dragging');
      top.style.transform = 'translateX(' + (dir * 140) + '%) rotate(' + (dir * 22) + 'deg)';
      top.style.opacity = '0';
      $('.stamp.' + (dir > 0 ? 'yes' : 'no'), top).style.opacity = 1;
      if (navigator.vibrate) navigator.vibrate(12);
      showToast(dir > 0 ? t('phone.approved') : t('phone.rejected', { name: card.name }));
      // promote the next cards while the top one flies out
      $$('.dcard', stackEl).forEach(function (el) {
        if (el === top) return;
        el.dataset.depth = Math.max(0, +el.dataset.depth - 1);
      });
      setTimeout(function () { index++; render(); }, reduceMotion ? 0 : 380);
    }
    function bindDrag(el) {
      var startX = 0, startY = 0, dx = 0, active = false, id = null;
      var yes = $('.stamp.yes', el), no = $('.stamp.no', el);
      el.addEventListener('pointerdown', function (e) {
        active = true; id = e.pointerId; startX = e.clientX; startY = e.clientY; dx = 0;
        el.setPointerCapture(id); el.classList.add('dragging');
      });
      el.addEventListener('pointermove', function (e) {
        if (!active || e.pointerId !== id) return;
        dx = e.clientX - startX; var dy = (e.clientY - startY) * .25;
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + (dx / 16) + 'deg)';
        yes.style.opacity = clamp(dx / 90, 0, 1); no.style.opacity = clamp(-dx / 90, 0, 1);
      });
      function end() {
        if (!active) return; active = false; el.classList.remove('dragging');
        if (Math.abs(dx) > 90) decide(dx > 0 ? 1 : -1);
        else { el.style.transform = ''; yes.style.opacity = 0; no.style.opacity = 0; }
      }
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { e.preventDefault(); decide(1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); decide(-1); }
      });
    }
    $('#btn-approve').addEventListener('click', function () { decide(1); });
    $('#btn-reject').addEventListener('click', function () { decide(-1); });
    $('#replay').addEventListener('click', function () { index = 0; render(); });
    listeners.push(render);

    // the phone leans toward the cursor
    if (finePointer && !reduceMotion) {
      var hero = $('.hero');
      hero.addEventListener('pointermove', function (e) {
        if (window.innerWidth <= 1000) return;
        var r = phone.getBoundingClientRect();
        var x = (e.clientX - (r.left + r.width / 2)) / window.innerWidth;
        var y = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
        phone.style.setProperty('--ry', clamp(-8 + x * 18, -18, 10) + 'deg');
        phone.style.setProperty('--rx', clamp(4 - y * 12, -8, 12) + 'deg');
      });
      hero.addEventListener('pointerleave', function () { phone.style.removeProperty('--ry'); phone.style.removeProperty('--rx'); });
    }
  })();

  /* ================= noise → signal ================= */
  (function noise() {
    var section = $('#noise'), field = $('#noise-field'), signal = $('#noise-signal');
    var steps = $$('.noise-step'), bar = $('#noise-bar');
    var COLORS = ['#e01e5a', '#36c5f0', '#2eb67d', '#ecb22e', '#6647f0', '#fa49a5', '#0091ff'];
    var LINES = [
      ['#general', 'Aiko', 'anyone seen the Q3 deck?'], ['#random', 'Ben', '🎉 lunch is here'],
      ['#design', 'Dana', 'v7 of the logo, thoughts?'], ['#eng', 'Leo', 'deploy is blocked again'],
      ['#sales', 'Rin', 'Re: Re: Fwd: pricing'], ['#hotel-ops', 'Ken', 'can someone approve this?'],
      ['DM', 'Mio', 'did you see my message?'], ['#cafe', 'Yuki', 'printer needs photos by 5'],
      ['#finance', 'Sam', 'invoice attached (again)'], ['#general', 'Nora', '@here quick sync?'],
      ['#eng', 'Taro', 'PR #412 needs a review'], ['#marketing', 'Ken', 'budget ask in thread ↑'],
      ['DM', 'Leo', 'ping'], ['#design', 'Aiko', 'moved to Figma, link inside'],
      ['#support', 'Ben', 'customer is waiting'], ['#hotel-ops', 'Rin', 'who owns spring promo?'],
      ['#random', 'Nora', 'coffee?'], ['#sales', 'Sam', 'deck v3_FINAL_final'],
      ['#eng', 'Dana', 'standup notes'], ['#general', 'Yuki', 'reminder: timesheets'],
      ['DM', 'Ken', '??'], ['#cafe', 'Mio', 'menu options 1/2/3'],
      ['#finance', 'Taro', 'need a yes by Friday'], ['#marketing', 'Aiko', 'IG draft ready'],
      ['#support', 'Leo', 'escalating'], ['#general', 'Ben', 'thread got long, tl;dr?'],
      ['#design', 'Rin', 'feedback pls 🙏'], ['#eng', 'Nora', 'flaky test again'],
      ['DM', 'Sam', 'call?'], ['#hotel-ops', 'Yuki', 'bookings down 12%'],
      ['#sales', 'Ken', 'enterprise lead!'], ['#random', 'Taro', '📎 photo.png']
    ];
    var pings = [];
    var small = window.innerWidth < 760;
    var count = small ? 22 : LINES.length;
    for (var i = 0; i < count; i++) {
      var l = LINES[i];
      var el = document.createElement('div');
      el.className = 'ping';
      var badge = Math.random() < .45 ? '<span class="badge">' + (1 + ((Math.random() * 24) | 0)) + '</span>' : '';
      el.innerHTML = '<i style="background:' + COLORS[i % COLORS.length] + '">' + l[1][0] + '</i><b>' + l[0] + '</b><span>' + l[1] + ': ' + l[2] + '</span>' + badge;
      field.appendChild(el);
      // keep the middle band a little clearer so the final card has room
      var fx = Math.random(), fy = Math.random() * .78 + .02;
      pings.push({ el: el, fx: fx, fy: fy, depth: .4 + Math.random() * .6, appear: Math.random() * .28, rot: (Math.random() - .5) * 8 });
    }
    var W = 0, H = 0;
    function measure() {
      W = field.clientWidth; H = field.clientHeight;
      pings.forEach(function (p) { p.w = p.el.offsetWidth; p.h = p.el.offsetHeight; });
    }
    var ticking = false;
    function update() {
      ticking = false;
      var r = section.getBoundingClientRect();
      var total = r.height - window.innerHeight;
      var p = clamp(-r.top / total, 0, 1);
      if (reduceMotion) p = p < .33 ? .2 : p < .66 ? .5 : 1;
      var c = clamp((p - .58) / .3, 0, 1);            // converge
      var ce = c * c * (3 - 2 * c);
      var dim = clamp((p - .3) / .25, 0, 1);          // everything but the one card fades back
      pings.forEach(function (o) {
        var a = clamp((p - o.appear) / .06, 0, 1);
        var x = o.fx * (W - o.w), y = o.fy * (H - o.h) - p * 120 * o.depth;
        var cx = W / 2 - o.w / 2, cy = H / 2 - o.h / 2;
        x = x + (cx - x) * ce; y = y + (cy - y) * ce;
        var s = (.85 + .15 * a) * (1 - .7 * ce) * (.9 + o.depth * .1);
        o.el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) rotate(' + (o.rot * (1 - ce)) + 'deg) scale(' + s.toFixed(3) + ')';
        o.el.style.opacity = (a * (1 - dim * .55) * (1 - ce)).toFixed(3);
        o.el.style.filter = dim > 0 ? 'blur(' + (dim * 1.5 * (1 - o.depth) + ce * 2).toFixed(2) + 'px)' : '';
      });
      var sIn = clamp((p - .72) / .2, 0, 1);
      signal.style.opacity = sIn;
      signal.style.transform = 'scale(' + (.85 + .15 * sIn) + ')';
      var idx = p < .33 ? 0 : p < .68 ? 1 : 2;
      steps.forEach(function (s, i) { s.classList.toggle('is-active', i === idx); });
      bar.style.width = (p * 100) + '%';
    }
    function req() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }
    measure(); update();
    window.addEventListener('scroll', req, { passive: true });
    window.addEventListener('resize', function () { measure(); req(); });
  })();

  /* ================= how it works: a tiny router ================= */
  (function router() {
    // The real router is a model call over the org graph (worker/src/ai); this is the
    // keyword fallback it degrades to, enough to show where an instruction lands.
    var PEOPLE = {
      design: { name: 'Dana', kw: ['design', 'landing', ' lp', 'figma', 'logo', 'ui', 'デザイン', 'ロゴ', 'lp', 'diseño', 'maquette', 'conception'] },
      eng: { name: 'Leo', kw: ['bug', 'fix', 'deploy', 'login', 'api', 'engineer', 'tech', 'バグ', '開発', '修正', 'ログイン', 'ingenier', 'error', 'bogue', 'connexion', 'fehler', 'engineering'] },
      finance: { name: 'Aya', kw: ['budget', 'invoice', 'cost', 'expense', 'pay', '予算', '請求', '経費', '支払', 'presupuesto', 'factura', 'facture', 'rechnung', 'kosten'] },
      sales: { name: 'Rin', kw: ['sales', 'customer', 'pricing', 'price', 'deal', 'client', '営業', '顧客', '価格', '値段', 'ventas', 'precio', 'ventes', 'tarif', 'vertrieb', 'kunde', 'preis'] }
    };
    var DECIDE = ['approv', 'sign off', 'sign-off', '承認', '決裁', 'aprob', 'approb', 'freigabe', 'genehmig', 'validat'];
    var TELL = ['tell', 'let ', 'share', 'inform', '伝え', '共有', '知らせ', 'dile', 'informa', 'dis ', 'dis-', 'sag ', 'sag,', 'informier'];
    var issueNo = 128, discussionNo = 42;

    var form = $('#composer'), input = $('#intent'), presets = $('#presets');
    var nodes = $$('#chain .node'), wires = $$('#chain .wire');
    var card = $('#result-card'), gh = $('#gh'), running = false, timers = [];
    var lastRun = null;

    function renderPresets() {
      presets.innerHTML = '';
      t('presets').forEach(function (p) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = p;
        b.addEventListener('click', function () {
          $$('button', presets).forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          input.value = p; run(p);
        });
        presets.appendChild(b);
      });
    }
    function classify(text) {
      var s = ' ' + text.toLowerCase() + ' ';
      var has = function (list) { return list.some(function (k) { return s.indexOf(k) > -1; }); };
      var role = 'design', best = 0;
      Object.keys(PEOPLE).forEach(function (k) {
        var score = PEOPLE[k].kw.filter(function (w) { return s.indexOf(w) > -1; }).length;
        if (score > best) { best = score; role = k; }
      });
      var kind = has(DECIDE) ? 'DECISION' : has(TELL) ? 'FYI' : 'TASK';
      var biz = /hotel|ホテル|本丸/.test(s) ? 'HOTEL 本丸' : /cafe|café|カフェ|sakura/.test(s) ? 'CAFE SAKURA' : /studio|スタジオ/.test(s) ? 'STUDIO K' : 'GENERAL';
      return { role: role, person: PEOPLE[role], kind: kind, biz: biz };
    }
    function paintResult(text, r) {
      var tagClass = { DECISION: 'tag-decision', TASK: 'tag-task', FYI: 'tag-fyi' }[r.kind];
      var kindEl = $('#r-kind'); kindEl.className = 'tag ' + tagClass; kindEl.textContent = r.kind;
      $('#r-biz').textContent = r.biz;
      $('#r-to').textContent = t('how.to', { name: r.person.name });
      var title = text.trim(); title = title.charAt(0).toUpperCase() + title.slice(1);
      $('#r-title').textContent = title;
      $('#r-title').removeAttribute('data-i18n');
      var reasonSpan = $('#r-reason span:last-child');
      reasonSpan.removeAttribute('data-i18n');
      reasonSpan.textContent = t('how.yourAi') + ' → ' + t('how.theirAi', { name: r.person.name }) + ' · ' + t('reason', { name: r.person.name, role: t('roles')[r.role] });
      $('#gh-issue').textContent = r.kind === 'FYI' ? 'Discussion #' + r.ghNo : 'Issue #' + r.ghNo;
    }
    function run(text) {
      if (!text || !text.trim()) { input.focus(); return; }
      timers.forEach(clearTimeout); timers = [];
      var r = classify(text);
      r.ghNo = r.kind === 'FYI' ? discussionNo++ : issueNo++;
      lastRun = { text: text, r: r };
      $('#their-ai').textContent = t('how.theirAi', { name: r.person.name });
      $('#their-name').textContent = r.person.name;
      $('#their-initial').textContent = r.person.name[0];
      nodes.forEach(function (n) { n.classList.remove('lit'); });
      wires.forEach(function (w) { w.classList.remove('lit'); });
      gh.classList.remove('on');
      card.style.opacity = '.35';
      var gap = reduceMotion ? 0 : 380;
      nodes.forEach(function (n, i) {
        timers.push(setTimeout(function () {
          n.classList.add('lit');
          if (wires[i]) wires[i].classList.add('lit');
        }, i * gap));
      });
      timers.push(setTimeout(function () {
        paintResult(text, r);
        card.style.opacity = '';
        card.classList.remove('enter'); void card.offsetWidth; card.classList.add('enter');
      }, nodes.length * gap));
      timers.push(setTimeout(function () { gh.classList.add('on'); }, nodes.length * gap + (reduceMotion ? 0 : 700)));
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      $$('button', presets).forEach(function (x) { x.classList.remove('on'); });
      run(input.value);
    });
    renderPresets();
    listeners.push(function () {
      renderPresets();
      if (lastRun) {
        $('#their-ai').textContent = t('how.theirAi', { name: lastRun.r.person.name });
        paintResult(lastRun.text, lastRun.r);
      } else {
        $('#their-ai').textContent = t('how.theirAi', { name: 'Dana' });
      }
    });
  })();

  /* ================= bento: spotlight + tilt ================= */
  if (finePointer && !reduceMotion) {
    $$('.tile').forEach(function (tile) {
      tile.addEventListener('pointermove', function (e) {
        var r = tile.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        tile.style.setProperty('--mx', (x * 100) + '%');
        tile.style.setProperty('--my', (y * 100) + '%');
        tile.style.setProperty('--ty', ((x - .5) * 5) + 'deg');
        tile.style.setProperty('--tx', ((.5 - y) * 5) + 'deg');
      });
      tile.addEventListener('pointerleave', function () {
        tile.style.setProperty('--tx', '0deg'); tile.style.setProperty('--ty', '0deg');
      });
    });
    var box = $('#cta-box');
    box.addEventListener('pointermove', function (e) {
      var r = box.getBoundingClientRect();
      box.style.setProperty('--cx', (e.clientX - r.left) + 'px');
      box.style.setProperty('--cy', (e.clientY - r.top) + 'px');
    });
  }

  /* ================= language tile: one card, every reader ================= */
  (function langTile() {
    var i = 0, code = $('#lang-code'), line = $('#lang-line'), wrap = $('.lang-card');
    var S = window.I18N_SAMPLE;
    if (reduceMotion) return;
    setInterval(function () {
      if (document.hidden) return;
      wrap.classList.add('swap');
      setTimeout(function () {
        i = (i + 1) % S.length;
        code.textContent = S[i][0]; line.textContent = S[i][1];
        wrap.classList.remove('swap');
      }, 280);
    }, 2200);
  })();

  applyLang();
})();
