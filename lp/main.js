(function () {
  'use strict';

  var doc = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var ease = function (t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  var easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  /* ============ language ============ */
  var LANGS = ['en', 'ja', 'es', 'fr', 'de'];
  // The published site has a page per language (/ja/, /en/ …); the root sends
  // each visitor to one by where they are (_worker.js). The path wins, then an
  // old ?lang= link, then what was chosen here before, then the browser.
  var pathLang = (location.pathname.match(/^\/(en|ja|es|fr|de)\/?$/) || [])[1] || null;
  var lang = (function () {
    if (pathLang) return pathLang;
    var q = new URLSearchParams(location.search).get('lang');
    if (LANGS.indexOf(q) > -1) return q;
    var s = store.get('honmaru-lang');
    if (LANGS.indexOf(s) > -1) return s;
    var nav = navigator.languages || [navigator.language || 'en'];
    for (var i = 0; i < nav.length; i++) {
      var b = String(nav[i]).slice(0, 2).toLowerCase();
      if (LANGS.indexOf(b) > -1) return b;
    }
    return 'en';
  })();
  var onLang = [];

  function t(key, vars) {
    var d = window.I18N[lang] || window.I18N.en;
    var v = key in d ? d[key] : window.I18N.en[key];
    if (typeof v === 'string' && vars) v = v.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? vars[k] : ''; });
    return v;
  }
  function applyLang(first) {
    // A page built for this language already carries its words; rewriting
    // them on load would only cost a frame.
    if (!(first && doc.getAttribute('data-prerendered') === lang)) {
      doc.lang = lang;
      document.title = t('meta.title');
      $('meta[name="description"]').setAttribute('content', t('meta.desc'));
      $$('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
      $$('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
      $$('[data-i18n-placeholder]').forEach(function (el) { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
      $$('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
      $$('[data-i18n-href]').forEach(function (el) { el.setAttribute('href', t(el.getAttribute('data-i18n-href'))); });
    }
    $('#lang-code').textContent = lang.toUpperCase();
    $('#lang-btn').setAttribute('aria-label', lang.toUpperCase() + ' · ' + t('a11y.language'));
    $('#fregion').textContent = t('region');
    $$('#lang-list li').forEach(function (li) { li.setAttribute('aria-selected', li.dataset.lang === lang ? 'true' : 'false'); });
    onLang.forEach(function (fn) { fn(); });
  }
  function setLang(l) {
    if (l === lang) return;
    lang = l;
    store.set('honmaru-lang', l);
    // the root reads this before it looks at the visitor's country
    try { document.cookie = 'hm_lang=' + l + '; path=/; max-age=31536000; SameSite=Lax'; } catch (e) {}
    var url = new URL(location.href);
    if (pathLang) { url.pathname = '/' + l + '/'; url.searchParams.delete('lang'); pathLang = l; }
    else url.searchParams.set('lang', l);
    history.replaceState(null, '', url);
    applyLang();
  }

  (function langMenu() {
    var btn = $('#lang-btn'), list = $('#lang-list'), items = $$('li', list), focus = -1;
    function open() {
      list.hidden = false; btn.setAttribute('aria-expanded', 'true');
      focus = LANGS.indexOf(lang); paint();
      setTimeout(function () { document.addEventListener('click', outside); }, 0);
    }
    function close() {
      list.hidden = true; btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', outside);
    }
    function outside(e) { if (!e.target.closest('#lang-menu')) close(); }
    function paint() { items.forEach(function (li, i) { li.classList.toggle('focus', i === focus); }); }
    btn.addEventListener('click', function () { list.hidden ? open() : close(); });
    items.forEach(function (li) { li.addEventListener('click', function () { setLang(li.dataset.lang); close(); btn.focus(); }); });
    btn.addEventListener('keydown', function (e) {
      if (list.hidden && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); return; }
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); focus = (focus + 1) % items.length; paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focus = (focus - 1 + items.length) % items.length; paint(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLang(items[focus].dataset.lang); close(); }
      else if (e.key === 'Escape' || e.key === 'Tab') close();
    });
    $('#fregion').addEventListener('click', function (e) { e.stopPropagation(); open(); btn.focus(); });
  })();

  /* ============ appearance ============ */
  var mqDark = window.matchMedia('(prefers-color-scheme: dark)');
  var themeListeners = [];
  if (mqDark.addEventListener) mqDark.addEventListener('change', function () { themeListeners.forEach(function (fn) { fn(); }); });
  function isDark() { var v = doc.getAttribute('data-theme'); return v ? v === 'dark' : mqDark.matches; }
  function paintThemeColor() {
    $$('meta[name="theme-color"]').forEach(function (m) { m.setAttribute('content', isDark() ? '#0b0c12' : '#ffffff'); });
  }
  $('#theme-btn').addEventListener('click', function () {
    var next = isDark() ? 'light' : 'dark';
    doc.setAttribute('data-theme', next); store.set('honmaru-theme', next);
    paintThemeColor();
    themeListeners.forEach(function (fn) { fn(); });
  });
  if (doc.getAttribute('data-theme')) paintThemeColor();

  /* ============ nav ============ */
  var navEl = $('#nav');
  $('#more-btn').addEventListener('click', function () {
    var open = !navEl.classList.contains('open');
    navEl.classList.toggle('open', open);
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  $$('#nav-links a').forEach(function (a) { a.addEventListener('click', function () { navEl.classList.remove('open'); $('#more-btn').setAttribute('aria-expanded', 'false'); }); });

  /* ============ reveal ============ */
  if ('IntersectionObserver' in window && !reduce) {
    var rio = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); rio.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -12% 0px' });
    $$('.reveal').forEach(function (el) {
      var sib = Array.prototype.filter.call(el.parentElement.children, function (c) { return c.classList.contains('reveal'); });
      el.style.setProperty('--d', (sib.indexOf(el) * .09) + 's');
      rio.observe(el);
    });
  } else {
    $$('.reveal').forEach(function (el) { el.classList.add('in'); });
  }

  /* ============ the stage: hero, then the pinned phone story ============ */
  var stage = (function () {
    var section = $('.stage'), sticky = $('.stage-sticky'), hero = $('#hero-text'), story = $('#story');
    var device = $('#device'), caps = $$('.caption'), rail = $$('#rail li');
    var card1 = $('#pcard1'), card2 = $('#pcard2'), stamp = $('#stamp'), banner = $('#banner');
    var triage = $('#triage'), yes = $('#yes-btn'), count = $('#ph-count');
    var RANGES = [[.12, .345], [.345, .545], [.545, .745], [.745, 1.01]];
    var m = {}, pose = { cx: 0, cy: 0, r: 200, p: 0 };

    function copyRect() {
      var a = hero.getBoundingClientRect(), b = story.getBoundingClientRect();
      var box = [Math.min(a.left, b.left), Math.min(a.top, b.top), Math.max(a.right, b.right), Math.max(a.bottom, b.bottom)];
      return m.wide ? box : null;
    }
    function measure() {
      device.style.transform = 'none';
      var vw = window.innerWidth, vh = sticky.clientHeight, wide = vw >= 1000;
      var dh = device.offsetHeight, dw = device.offsetWidth;
      m = { vw: vw, vh: vh, wide: wide, dh: dh, u: dw / 433 };
      if (wide) {
        m.s1 = m.s0 = Math.min(1, (vh - 130) / dh);
        m.x1 = m.x0 = Math.min(vw, 1160) * .25;
        m.y1 = m.y0 = 34;
        story.style.top = '';
      } else {
        var heroBottom = hero.offsetTop + hero.offsetHeight;
        m.x0 = m.x1 = 0; m.s0 = 1;
        m.y0 = heroBottom + 34 + dh / 2 - vh / 2;
        var capH = story.offsetHeight, top = 84;
        m.s1 = Math.min(1, (vh - top - capH - 30) / dh);
        m.y1 = top + dh * m.s1 / 2 - vh / 2;
        var below = top + dh * m.s1, room = vh - below - capH;
        story.style.top = (below + Math.max(10, room * .42)) + 'px';
      }
      hero.style.transform = 'none';
      pose.avoid = copyRect();
    }

    function update(r) {
      var p = clamp(-r.top / (r.height - m.vh), 0, 1);
      var h = ease(clamp(p / .12, 0, 1)), ho = clamp(p / .08, 0, 1);
      hero.style.opacity = 1 - ho;
      hero.style.transform = 'translate3d(0,' + (-h * 50).toFixed(1) + 'px,0)';
      hero.style.visibility = ho >= 1 ? 'hidden' : '';

      var so = clamp((p - .1) / .04, 0, 1);
      story.style.opacity = so;
      story.style.visibility = so <= 0 ? 'hidden' : 'visible';

      var x = lerp(m.x0, m.x1, h), y = lerp(m.y0, m.y1, h), s = lerp(m.s0, m.s1, h);
      device.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + s.toFixed(4) + ')';
      pose.cx = m.vw / 2 + x; pose.cy = m.vh / 2 + y; pose.r = m.dh * s * .56; pose.p = p;

      var active = 0;
      RANGES.forEach(function (rg, i) { if (p >= rg[0]) active = i; });
      rail.forEach(function (li, i) {
        var f = i < active ? 1 : i === active ? clamp((p - RANGES[i][0]) / (RANGES[i][1] - RANGES[i][0]), 0, 1) : 0;
        li.style.setProperty('--f', f.toFixed(3));
        li.classList.toggle('on', i === active);
      });

      caps.forEach(function (c, i) {
        var a = RANGES[i][0], b = RANGES[i][1];
        var fin = clamp((p - a) / .045, 0, 1), fout = i < 3 ? clamp((b - p) / .045, 0, 1) : 1;
        var o = Math.min(fin, fout);
        c.style.opacity = o.toFixed(3);
        c.style.transform = 'translate3d(0,' + ((1 - fin) * 28 - (1 - fout) * 28).toFixed(1) + 'px,0)';
        c.style.visibility = o <= 0 ? 'hidden' : '';
      });

      var g = 1 - clamp((p - .29) / .06, 0, 1);
      device.style.setProperty('--glow', g.toFixed(3));
      triage.style.opacity = g.toFixed(3);
      triage.style.transform = 'translateY(' + ((1 - g) * -10).toFixed(1) + 'px)';

      var sw = ease(clamp((p - .40) / .12, 0, 1));
      card1.style.transform = 'translate3d(' + (sw * 135).toFixed(2) + '%,' + (sw * -4).toFixed(2) + '%,0) rotate(' + (sw * 18).toFixed(2) + 'deg)';
      stamp.style.opacity = clamp(sw * 4, 0, 1).toFixed(3);
      yes.classList.toggle('pressed', sw > 0 && sw < .5);
      count.textContent = sw > .5 ? '2' : '3';

      var bIn = easeOut(clamp((p - .56) / .04, 0, 1)), bOut = clamp((p - .705) / .035, 0, 1);
      var b = bIn * (1 - bOut);
      banner.style.opacity = b.toFixed(3);
      banner.style.transform = 'translate3d(0,' + ((1 - bIn) * -160 - bOut * 40).toFixed(1) + '%,0) scale(' + (.96 + .04 * bIn).toFixed(4) + ')';

      var n = easeOut(clamp((p - .56) / .1, 0, 1)) * .3 + easeOut(clamp((p - .76) / .1, 0, 1)) * .7;
      card2.style.transform = 'translate3d(0,' + ((1 - n) * 10 * m.u).toFixed(2) + 'px,0) scale(' + (.95 + .05 * n).toFixed(4) + ')';
      card2.style.opacity = (.5 + .5 * n).toFixed(3);
    }

    measure();
    return { update: update, measure: measure, pose: pose };
  })();

  /* ============ the walls: rings around the phone ============
     Three walls — 三の丸, 二の丸, 本丸. Messages drift along the outer walls;
     every so often your AI lets one through and it falls inward to the phone. */
  (function rings() {
    var canvas = $('#rings'), ctx = canvas.getContext('2d'), section = $('.stage');
    var W = 0, H = 0, dpr = 1, parts = [], flashes = [], ink = '32,32,32', vio = '102,71,240';
    var running = false, raf = 0, last = 0, nextDive = 0;
    // The walls and their names only change when the phone moves or the theme
    // flips, so they are drawn once to their own canvas and stamped each frame.
    var walls = document.createElement('canvas'), wctx = walls.getContext('2d'), wallsKey = '';
    // Small or touch screens get 30 frames a second; the drift reads the same.
    var frameGap = (window.innerWidth < 700 || window.matchMedia('(pointer: coarse)').matches) ? 32 : 0;
    var LABELS = ['本丸', '二の丸', '三の丸'];

    function colors() {
      var cs = getComputedStyle(doc);
      ink = cs.getPropertyValue('--ring-rgb').trim() || ink;
      vio = cs.getPropertyValue('--violet-rgb').trim() || vio;
    }
    function size() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = walls.width = W * dpr; canvas.height = walls.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      wallsKey = '';
      var n = W < 700 ? 26 : 46;
      parts = [];
      for (var i = 0; i < n; i++) parts.push(spawn(1 + (i % 2)));
    }
    function spawn(ring) {
      return { ring: ring, a: Math.random() * Math.PI * 2, w: (ring === 2 ? -1 : 1) * (.05 + Math.random() * .06), jitter: (Math.random() - .5) * .08, dive: -1, sz: 1.6 + Math.random() * 1.6 };
    }
    var ANGLES = [];
    for (var d = 0; d <= 18; d++) ANGLES.push(.8 + (d % 2 ? 1 : -1) * Math.ceil(d / 2) * .05);
    function labelSpot(P, r) {
      var av = stage.pose.avoid;
      for (var i = 0; i < ANGLES.length; i++) {
        var a = Math.PI * ANGLES[i], x = P.cx + Math.cos(a) * r, y = P.cy + Math.sin(a) * r;
        if (x < 16 || x > W - 70 || y < 96 || y > H - 20) continue;
        if (av && x > av[0] - 70 && x < av[2] + 16 && y > av[1] - 16 && y < av[3] + 16) continue;
        return [x, y];
      }
      return null;
    }
    function radii() { var R = Math.max(stage.pose.r, 150); return [R, R * 1.42, R * 1.9]; }
    function drawWalls(P, rr) {
      var av = P.avoid || [];
      var key = [P.cx | 0, P.cy | 0, rr[0] | 0, W, H, ink, vio, av.join()].join('|');
      if (key === wallsKey) return;
      wallsKey = key;
      wctx.clearRect(0, 0, W, H);
      for (var i = 2; i >= 0; i--) {
        wctx.beginPath();
        wctx.setLineDash(i === 0 ? [] : [2, 7]);
        wctx.lineWidth = i === 0 ? 1.3 : 1;
        wctx.strokeStyle = i === 0 ? 'rgba(' + vio + ',.45)' : 'rgba(' + ink + ',' + (i === 1 ? .16 : .11) + ')';
        wctx.arc(P.cx, P.cy, rr[i], 0, Math.PI * 2);
        wctx.stroke();
      }
      wctx.setLineDash([]);
      // wall names: the first spot on each wall that is on screen and clear of the copy
      wctx.font = '500 11px "Sometype Mono", ui-monospace, monospace';
      for (var j = 0; j < 3; j++) {
        var spot = labelSpot(P, rr[j]);
        if (!spot) continue;
        wctx.fillStyle = j === 0 ? 'rgba(' + vio + ',1)' : 'rgba(' + ink + ',.5)';
        wctx.beginPath(); wctx.arc(spot[0], spot[1], 2.5, 0, Math.PI * 2); wctx.fill();
        wctx.fillText(LABELS[j], spot[0] + 8, spot[1] + 4);
      }
    }
    function draw(dt) {
      var P = stage.pose, rr = radii();
      drawWalls(P, rr);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(walls, 0, 0, W, H);
      // messages
      var dts = dt / 1000;
      for (var k = 0; k < parts.length; k++) {
        var q = parts[k], rad, alpha, col;
        q.a += q.w * dts;
        if (q.dive >= 0) {
          q.dive += dts / 1.5;
          var e = easeOut(Math.min(q.dive, 1));
          rad = lerp(rr[q.ring], rr[0] * .98, e);
          q.a += q.w * dts * 4;
          col = vio; alpha = .9;
          if (q.dive >= 1) {
            flashes.push({ a: q.a, t: 0 });
            parts[k] = spawn(1 + (Math.random() < .5 ? 1 : 0));
            continue;
          }
        } else {
          rad = rr[q.ring] * (1 + q.jitter * .3);
          col = ink; alpha = q.ring === 2 ? .3 : .42;
        }
        var px = P.cx + Math.cos(q.a) * rad, py = P.cy + Math.sin(q.a) * rad;
        if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
        ctx.fillStyle = 'rgba(' + col + ',' + alpha + ')';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(px - q.sz * 2.2, py - q.sz, q.sz * 4.4, q.sz * 2, q.sz); else ctx.rect(px - q.sz * 2.2, py - q.sz, q.sz * 4.4, q.sz * 2);
        ctx.fill();
      }
      // arrivals ripple on the keep's wall
      for (var f = flashes.length - 1; f >= 0; f--) {
        var fl = flashes[f]; fl.t += dts / .9;
        if (fl.t >= 1) { flashes.splice(f, 1); continue; }
        var fx = P.cx + Math.cos(fl.a) * rr[0], fy = P.cy + Math.sin(fl.a) * rr[0];
        ctx.strokeStyle = 'rgba(' + vio + ',' + (1 - fl.t) * .7 + ')';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(fx, fy, 4 + fl.t * 22, 0, Math.PI * 2); ctx.stroke();
      }
    }
    function loop(ts) {
      if (!running) return;
      if (last && ts - last < frameGap) { raf = requestAnimationFrame(loop); return; }
      var dt = Math.min(50, ts - (last || ts)); last = ts;
      if (ts > nextDive) {
        var cand = parts.filter(function (q) { return q.dive < 0; });
        if (cand.length) cand[(Math.random() * cand.length) | 0].dive = 0;
        // busier while the AI is triaging, calmer once you are deciding
        nextDive = ts + (stage.pose.p < .34 ? 650 : 1500) + Math.random() * 600;
      }
      draw(dt);
      raf = requestAnimationFrame(loop);
    }
    function start() { if (running || reduce) return; running = true; last = 0; raf = requestAnimationFrame(loop); }
    function stop() { running = false; cancelAnimationFrame(raf); }
    colors(); size();
    themeListeners.push(function () { colors(); wallsKey = ''; if (reduce) draw(0); });
    // the wall names are drawn in the mono face; redraw once it has arrived
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { wallsKey = ''; });
    var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { size(); if (reduce) draw(0); }, 120); });
    if (reduce) { draw(0); window.addEventListener('scroll', function () { draw(0); }, { passive: true }); return; }
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { es[0].isIntersecting ? start() : stop(); }).observe(section);
    else start();
    document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });
  })();

  /* ============ the keep: the name, read and drawn as you scroll ============ */
  var keep = (function () {
    var section = $('#keep'), box = $('#keep-text'), mark = $('.keep-mark'), plan = $('.keep-plan'), words = [];
    function build() {
      box.textContent = '';
      words = [];
      t('keep.text').split('*').forEach(function (seg, i) {
        var hl = i % 2 === 1;
        var tokens = lang === 'ja' ? seg.match(/[^、。]+[、。]?|[、。]/g) || [] : seg.split(/(\s+)/);
        tokens.forEach(function (tok) {
          if (!tok) return;
          if (/^\s+$/.test(tok)) { box.appendChild(document.createTextNode(tok)); return; }
          (lang === 'ja' ? Array.from(tok) : [tok]).forEach(function (ch) {
            var s = document.createElement('span');
            s.className = 'w' + (hl ? ' hl' : '');
            s.textContent = ch;
            box.appendChild(s);
            words.push(s);
          });
        });
      });
      box.setAttribute('aria-label', t('keep.text').replace(/\*/g, ''));
    }
    function update(r) {
      var vh = window.innerHeight;
      var p = clamp((-r.top + vh * .2) / (r.height - vh * .8), 0, 1);
      var lit = Math.round(clamp(p / .8, 0, 1) * words.length);
      for (var i = 0; i < words.length; i++) words[i].classList.toggle('lit', i < lit);
      plan.style.setProperty('--k3', clamp(p / .3, 0, 1).toFixed(3));
      plan.style.setProperty('--k2', clamp((p - .22) / .3, 0, 1).toFixed(3));
      plan.style.setProperty('--k1', clamp((p - .45) / .25, 0, 1).toFixed(3));
      mark.style.setProperty('--kk', clamp((p - .65) / .2, 0, 1).toFixed(3));
    }
    build();
    onLang.push(function () { build(); request(); });
    return { update: update };
  })();

  /* ============ one scroll loop for everything scroll-linked ============ */
  var ticking = false;
  var stageEl = $('.stage'), keepEl = $('#keep');
  function frame() {
    ticking = false;
    // every read before any write, so the browser lays out once per frame
    var sr = stageEl.getBoundingClientRect(), kr = keepEl.getBoundingClientRect();
    stage.update(sr); keep.update(kr);
    navEl.classList.toggle('over-dark', kr.top < 64 && kr.bottom > 40);
  }
  function request() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }
  window.addEventListener('scroll', request, { passive: true });
  var rs;
  window.addEventListener('resize', function () {
    clearTimeout(rs);
    rs = setTimeout(function () { stage.measure(); request(); }, 80);
  });
  onLang.push(function () { stage.measure(); request(); });

  /* ============ how it works: route an instruction ============ */
  (function router() {
    // The shipped router asks a model to read the org graph (worker/src). When there
    // is no model it falls back to keywords — which is what this demo runs.
    var PEOPLE = {
      design: { name: 'Dana', kw: ['design', 'landing', 'figma', 'logo', ' ui', 'デザイン', 'ロゴ', 'lp', 'diseño', 'maquette'] },
      eng: { name: 'Leo', kw: ['bug', 'fix', 'deploy', 'login', 'api', 'engineer', 'バグ', '開発', '修正', 'ログイン', 'ingenier', 'error', 'bogue', 'connexion', 'tech', 'fehler'] },
      finance: { name: 'Aya', kw: ['budget', 'invoice', 'cost', 'expense', 'pay', '予算', '請求', '経費', '支払', 'presupuesto', 'factura', 'facture', 'rechnung', 'kosten'] },
      sales: { name: 'Rin', kw: ['sales', 'customer', 'pricing', 'price', 'deal', 'client', '営業', '顧客', '価格', 'ventas', 'precio', 'ventes', 'tarif', 'vertrieb', 'kunde', 'preis'] }
    };
    var DECIDE = ['approv', 'sign-off', 'sign off', '承認', '決裁', 'visto bueno', 'aprob', 'approb', 'feu vert', 'freigabe', 'genehmig'];
    var TELL = ['tell', 'let ', 'know', 'share', 'inform', '伝え', '共有', '知らせ', 'avisa', 'dile', 'préviens', 'dis ', 'sag ', 'informier'];
    var DOT = { DECISION: 'pink', TASK: 'violet', FYI: 'blue' };
    var issueNo = 128, discNo = 42;

    var form = $('#prompt'), input = $('#intent'), chips = $('#chips');
    var nodes = $$('.flow-node'), fill = $('#flow-fill'), dot = $('#flow-dot');
    var card = $('#ocard'), gh = $('#o-gh');
    var last = null, anim = 0, timers = [];

    function classify(text) {
      var s = ' ' + text.toLowerCase() + ' ';
      var has = function (l) { return l.some(function (k) { return s.indexOf(k) > -1; }); };
      var role = 'design', best = 0;
      Object.keys(PEOPLE).forEach(function (k) {
        var n = PEOPLE[k].kw.filter(function (w) { return s.indexOf(w) > -1; }).length;
        if (n > best) { best = n; role = k; }
      });
      var kind = has(DECIDE) ? 'DECISION' : has(TELL) ? 'FYI' : 'TASK';
      var biz = /hotel|ホテル|本丸/.test(s) ? 'HOTEL 本丸' : /cafe|café|カフェ|sakura/.test(s) ? 'CAFE SAKURA' : 'GENERAL';
      return { role: role, who: PEOPLE[role].name, kind: kind, biz: biz };
    }
    function setPerson(name) {
      $('#fl-their-ai').textContent = t('how.theirAi', { name: name });
      $('#fl-them').textContent = name;
      $('#fn-them').textContent = name[0];
    }
    function paint(r) {
      $('#o-dot').className = DOT[r.kind];
      var k = $('#o-kind'); k.removeAttribute('data-i18n'); k.textContent = t('kinds')[r.kind] + ' · ' + r.biz;
      var title = r.text.trim(); title = title.charAt(0).toUpperCase() + title.slice(1);
      var h = $('#o-title'); h.removeAttribute('data-i18n'); h.textContent = title;
      var rs = $('#o-reason'); rs.removeAttribute('data-i18n');
      rs.textContent = t('how.yourAi') + ' → ' + t('how.theirAi', { name: r.who }) + ' · ' + t('reason', { name: r.who, role: t('roles')[r.role] });
      $('#o-issue').textContent = (r.kind === 'FYI' ? 'Discussion #' : 'Issue #') + r.no;
    }
    function flow(done) {
      cancelAnimationFrame(anim);
      nodes.forEach(function (n) { n.classList.remove('lit'); });
      var start = null, dur = reduce ? 1 : 1500;
      dot.style.opacity = 1;
      function step(ts) {
        if (start === null) start = ts;
        var k = clamp((ts - start) / dur, 0, 1), e = ease(k);
        fill.style.width = (e * 100) + '%';
        dot.style.left = (e * 100) + '%';
        nodes.forEach(function (n, i) { if (e >= i / 3 - .001) n.classList.add('lit'); });
        if (k < 1) anim = requestAnimationFrame(step);
        else { dot.style.opacity = 0; if (done) done(); }
      }
      anim = requestAnimationFrame(step);
    }
    function run(text) {
      if (!text || !text.trim()) { input.focus(); return; }
      timers.forEach(clearTimeout); timers = [];
      var r = classify(text);
      r.text = text; r.no = r.kind === 'FYI' ? discNo++ : issueNo++;
      last = r;
      setPerson(r.who);
      form.classList.add('running');
      card.classList.add('pending'); card.classList.remove('land');
      gh.classList.remove('on');
      flow(function () {
        form.classList.remove('running');
        paint(r);
        card.classList.remove('pending'); void card.offsetWidth; card.classList.add('land');
        timers.push(setTimeout(function () { gh.classList.add('on'); }, reduce ? 0 : 700));
      });
    }
    function renderChips() {
      chips.innerHTML = '';
      t('presets').forEach(function (text) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = text;
        b.addEventListener('click', function () {
          $$('button', chips).forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on'); input.value = text; run(text);
        });
        chips.appendChild(b);
      });
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      $$('button', chips).forEach(function (x) { x.classList.remove('on'); });
      run(input.value);
    });
    renderChips();
    setPerson('Dana');
    onLang.push(function () {
      renderChips();
      setPerson(last ? last.who : 'Dana');
      if (last) paint(last);
    });
    if ('IntersectionObserver' in window) {
      var fio = new IntersectionObserver(function (es) {
        if (es[0].isIntersecting) { fio.disconnect(); if (!last) setTimeout(function () { flow(); }, 500); }
      }, { threshold: .6 });
      fio.observe($('#flow'));
    }
  })();

  /* ============ the language slide: one card, every reader ============ */
  (function langStack() {
    var box = $('#lang-stack'), S = window.I18N_SAMPLE, front = 0;
    var cards = S.map(function (s) {
      var el = document.createElement('div');
      el.className = 'lcard';
      el.innerHTML = '<span class="lc">' + s[0] + '</span><span></span>';
      el.lastChild.textContent = s[1];
      box.appendChild(el);
      return el;
    });
    function place() {
      cards.forEach(function (c, i) {
        var k = (i - front + cards.length) % cards.length;
        var y = -50 - k * 16, sc = 1 - k * .07, o = k === 0 ? 1 : k === 1 ? .35 : k === 2 ? .12 : 0;
        c.style.transform = 'translateY(' + y + '%) scale(' + sc + ')';
        c.style.opacity = o;
        c.style.zIndex = 10 - k;
      });
    }
    place();
    if (reduce) return;
    setInterval(function () {
      if (document.hidden || !box.closest('.row').classList.contains('in')) return;
      front = (front + 1) % cards.length; place();
    }, 1500);
  })();

  // the conic ring spins only while the finale is on screen
  if ('IntersectionObserver' in window) {
    var fin = $('#finale');
    new IntersectionObserver(function (es) { fin.classList.toggle('live', es[0].isIntersecting); }).observe(fin);
  }
  $('#year').textContent = new Date().getFullYear();
  applyLang(true);
  frame();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { stage.measure(); frame(); });
})();
