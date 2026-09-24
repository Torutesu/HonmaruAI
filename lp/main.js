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
  var lang = (function () {
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
  function applyLang() {
    doc.lang = lang;
    document.title = t('meta.title');
    $('meta[name="description"]').setAttribute('content', t('meta.desc'));
    $$('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    $$('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    $$('[data-i18n-placeholder]').forEach(function (el) { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
    $$('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
    $('#lang-code').textContent = lang.toUpperCase();
    $('#fregion').textContent = t('region');
    $$('#lang-list li').forEach(function (li) { li.setAttribute('aria-selected', li.dataset.lang === lang ? 'true' : 'false'); });
    onLang.forEach(function (fn) { fn(); });
  }
  function setLang(l) {
    if (l === lang) return;
    lang = l;
    store.set('honmaru-lang', l);
    var url = new URL(location.href); url.searchParams.set('lang', l);
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
  function isDark() { var v = doc.getAttribute('data-theme'); return v ? v === 'dark' : mqDark.matches; }
  function paintThemeColor() {
    $$('meta[name="theme-color"]').forEach(function (m) { m.setAttribute('content', isDark() ? '#000000' : '#ffffff'); });
  }
  $('#theme-btn').addEventListener('click', function () {
    var next = isDark() ? 'light' : 'dark';
    doc.setAttribute('data-theme', next); store.set('honmaru-theme', next);
    paintThemeColor();
  });
  if (doc.getAttribute('data-theme')) paintThemeColor();

  /* ============ nav ============ */
  var navEl = $('#nav');
  $('#more-btn').addEventListener('click', function () {
    var open = !navEl.classList.contains('open');
    navEl.classList.toggle('open', open);
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  $$('#nav-links a').forEach(function (a) { a.addEventListener('click', function () { navEl.classList.remove('open'); }); });

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

  /* ============ the stage: hero → pinned phone story ============ */
  var stage = (function () {
    var section = $('.stage'), sticky = $('.stage-sticky'), hero = $('#hero-text');
    var device = $('#device'), caps = $$('.caption'), capsWrap = $('#captions');
    var card1 = $('#pcard1'), card2 = $('#pcard2'), stamp = $('#stamp'), banner = $('#banner');
    var triage = $('#triage'), yes = $('#yes-btn'), count = $('#ph-count');
    var RANGES = [[.15, .345], [.345, .545], [.545, .745], [.745, 1.01]];
    var m = {};

    function measure() {
      device.style.transform = 'none';
      var vw = window.innerWidth, vh = sticky.clientHeight;
      var wide = vw >= 1000;
      var dh = device.offsetHeight, dw = device.offsetWidth;
      var heroBottom = hero.offsetTop + hero.offsetHeight;
      m = { vw: vw, vh: vh, wide: wide, dh: dh, u: dw / 433 };
      m.x0 = 0; m.s0 = 1;
      m.y0 = heroBottom + (wide ? 56 : 36) + dh / 2 - vh / 2;
      if (wide) {
        m.s1 = Math.min(1, (vh - 100) / dh);
        m.x1 = Math.min(vw, 1000) * .25;
        m.y1 = 22;
      } else {
        var capH = capsWrap.offsetHeight + 28;
        m.s1 = Math.min(1, (vh - 52 - capH - 26) / dh);
        m.x1 = 0;
        m.y1 = 52 + 14 + dh * m.s1 / 2 - vh / 2;
        // captions sit centered in whatever room the phone leaves below it
        var below = 52 + 14 + dh * m.s1, room = vh - below - capsWrap.offsetHeight;
        capsWrap.style.top = Math.max(below + 8, below + room * .45) + 'px';
      }
      if (wide) capsWrap.style.top = '';
    }

    function update() {
      var r = section.getBoundingClientRect();
      var p = clamp(-r.top / (r.height - m.vh), 0, 1);

      var h = ease(clamp(p / .14, 0, 1));
      var ho = clamp(p / .09, 0, 1);
      hero.style.opacity = 1 - ho;
      hero.style.transform = 'translate3d(0,' + (-h * 70).toFixed(1) + 'px,0) scale(' + (1 - h * .04).toFixed(4) + ')';
      hero.style.visibility = ho >= 1 ? 'hidden' : '';

      var x = lerp(m.x0, m.x1, h), y = lerp(m.y0, m.y1, h), s = lerp(m.s0, m.s1, h);
      device.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + s.toFixed(4) + ')';

      caps.forEach(function (c, i) {
        var a = RANGES[i][0], b = RANGES[i][1];
        var fin = clamp((p - a) / .045, 0, 1), fout = i < 3 ? clamp((b - p) / .045, 0, 1) : 1;
        var o = Math.min(fin, fout);
        c.style.opacity = o.toFixed(3);
        c.style.transform = 'translate3d(0,' + ((1 - fin) * 36 - (1 - fout) * 36).toFixed(1) + 'px,0)';
        c.style.visibility = o <= 0 ? 'hidden' : '';
      });

      // the AI glow while it "triages", fading once you start deciding
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
    return { update: update, measure: measure };
  })();

  /* ============ statement: words light up as you read ============ */
  var statement = (function () {
    var section = $('#statement'), box = $('#statement-text'), words = [];
    function build() {
      box.textContent = '';
      words = [];
      t('statement').split('*').forEach(function (seg, i) {
        var ai = i % 2 === 1;
        var tokens = lang === 'ja' ? seg.match(/[^、。]+[、。]?|[、。]/g) || [] : seg.split(/(\s+)/);
        tokens.forEach(function (tok) {
          if (!tok) return;
          if (/^\s+$/.test(tok)) { box.appendChild(document.createTextNode(tok)); return; }
          var parts = lang === 'ja' ? Array.from(tok) : [tok];
          parts.forEach(function (ch) {
            var s = document.createElement('span');
            s.className = 'w' + (ai ? ' ai' : '');
            s.textContent = ch;
            box.appendChild(s);
            words.push(s);
          });
        });
      });
      box.setAttribute('aria-label', t('statement').replace(/\*/g, ''));
    }
    function update() {
      var r = section.getBoundingClientRect(), vh = window.innerHeight;
      var p = clamp((-r.top + vh * .15) / (r.height - vh * .9), 0, 1);
      var lit = Math.round(p * words.length * 1.08);
      for (var i = 0; i < words.length; i++) words[i].classList.toggle('lit', i < lit);
    }
    build();
    onLang.push(function () { build(); update(); });
    return { update: update };
  })();

  /* ============ one scroll loop for everything scroll-linked ============ */
  var ticking = false;
  function frame() {
    ticking = false;
    stage.update(); statement.update();
    navEl.classList.toggle('lined', window.scrollY > 10);
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

  /* ============ highlights gallery ============ */
  (function gallery() {
    var g = $('#gallery'), slides = $$('.slide', g), dotsWrap = $('#dots'), play = $('#play');
    var DUR = 5200, idx = 0, playing = !reduce, inView = false, timer = 0, scrollT = 0, programmatic = false;
    var dots = slides.map(function (s, i) {
      var d = document.createElement('button');
      d.type = 'button'; d.className = 'dot'; d.setAttribute('role', 'tab');
      d.setAttribute('aria-label', (i + 1) + ' / ' + slides.length);
      d.innerHTML = '<i></i>';
      d.style.setProperty('--dur', DUR + 'ms');
      d.addEventListener('click', function () { go(i, true); });
      dotsWrap.appendChild(d);
      return d;
    });
    function offset(i) { return slides[i].offsetLeft - slides[0].offsetLeft; }
    function setActive(i) {
      idx = i;
      slides.forEach(function (s, k) { s.classList.toggle('active', k === i); });
      dots.forEach(function (d, k) {
        d.classList.toggle('active', k === i);
        d.setAttribute('aria-selected', k === i ? 'true' : 'false');
        d.classList.remove('run');
      });
      arm();
    }
    function arm() {
      clearTimeout(timer);
      var d = dots[idx];
      d.classList.remove('run');
      if (!(playing && inView)) return;
      void d.offsetWidth; d.classList.add('run');
      timer = setTimeout(function () { go((idx + 1) % slides.length); }, DUR);
    }
    function go(i) {
      programmatic = true;
      g.scrollTo({ left: offset(i), behavior: reduce ? 'auto' : 'smooth' });
      setActive(i);
      setTimeout(function () { programmatic = false; }, 700);
    }
    function setPlaying(v) {
      playing = v;
      play.classList.toggle('paused', !v);
      play.setAttribute('aria-label', t(v ? 'hl.pause' : 'hl.play'));
      arm();
    }
    g.addEventListener('scroll', function () {
      if (programmatic) return;
      clearTimeout(scrollT);
      scrollT = setTimeout(function () {
        var best = 0, bd = Infinity;
        slides.forEach(function (s, k) { var d = Math.abs(offset(k) - g.scrollLeft); if (d < bd) { bd = d; best = k; } });
        if (best !== idx) setActive(best);
      }, 90);
    }, { passive: true });
    ['pointerdown', 'touchstart', 'wheel'].forEach(function (ev) {
      g.addEventListener(ev, function (e) {
        if (ev === 'wheel' && Math.abs(e.deltaX) < Math.abs(e.deltaY)) return;
        if (playing) setPlaying(false);
      }, { passive: true });
    });
    g.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); go(Math.min(idx + 1, slides.length - 1)); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setPlaying(false); go(Math.max(idx - 1, 0)); }
    });
    play.addEventListener('click', function () { setPlaying(!playing); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { inView = es[0].isIntersecting; arm(); }, { threshold: .5 }).observe(g);
    }
    document.addEventListener('visibilitychange', function () { inView = !document.hidden && inView; arm(); });
    setPlaying(playing);
    setActive(0);
    onLang.push(function () { play.setAttribute('aria-label', t(playing ? 'hl.pause' : 'hl.play')); });
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
        var y = -50 - k * 11, sc = 1 - k * .06, o = k === 0 ? 1 : k === 1 ? .55 : k === 2 ? .22 : 0;
        c.style.transform = 'translateY(' + y + '%) scale(' + sc + ')';
        c.style.opacity = o;
        c.style.zIndex = 10 - k;
      });
    }
    place();
    if (reduce) return;
    setInterval(function () {
      if (document.hidden || !box.closest('.slide').classList.contains('active')) return;
      front = (front + 1) % cards.length; place();
    }, 1500);
  })();

  /* ============ numbers ============ */
  (function numbers() {
    var els = $$('[data-count]');
    if (!('IntersectionObserver' in window) || reduce) return;
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        var el = e.target, to = +el.dataset.count, from = to === 0 ? 40 : 0, start = null;
        function step(ts) {
          if (start === null) start = ts;
          var k = clamp((ts - start) / 1400, 0, 1);
          el.textContent = Math.round(lerp(from, to, easeOut(k)));
          if (k < 1) requestAnimationFrame(step);
        }
        el.textContent = from;
        requestAnimationFrame(step);
      });
    }, { threshold: .6 });
    els.forEach(function (el) { io.observe(el); });
  })();

  applyLang();
  frame();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { stage.measure(); frame(); });
})();
