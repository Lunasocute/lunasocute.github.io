/* script.js — page choreography.
 *
 * One requestAnimationFrame loop owns everything that moves with scroll. Native scrolling
 * is kept (no fake scroller), mouse wheels are smoothed, and every scroll-linked value is
 * critically damped, so a notchy wheel or a scrollbar drag still animates like a trackpad.
 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (x, a = 0, b = 1) => Math.min(Math.max(x, a), b);
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const damp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
  const root = document.documentElement;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ---------- springs ---------- */

  // Solve a damped harmonic oscillator and express it as a CSS linear() easing.
  function spring(stiffness, damping, samples = 48) {
    const w0 = Math.sqrt(stiffness), z = damping / (2 * w0);
    const f = t => {
      if (z < 1) {
        const wd = w0 * Math.sqrt(1 - z * z);
        return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + (z * w0 / wd) * Math.sin(wd * t));
      }
      return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
    };
    let T = 0;
    for (let t = 4; t > 0; t -= .01) if (Math.abs(1 - f(t)) > .002) { T = t; break; }
    const pts = [];
    for (let i = 0; i <= samples; i++) pts.push(+f(T * i / samples).toFixed(4));
    pts[samples] = 1;
    return { easing: `linear(${pts.join(',')})`, ms: Math.round(T * 1000) };
  }
  const SPRING = spring(170, 21);        // lively: thumb, press states
  const SOFT = spring(90, 19);           // unhurried: reveals
  const SHEET_IN = spring(150, 21);
  const SHEET_OUT = spring(210, 29);
  const hasLinear = window.CSS && CSS.supports('transition-timing-function', 'linear(0,1)');
  if (hasLinear) {
    root.style.setProperty('--spring', SPRING.easing);
    root.style.setProperty('--spring-soft', SOFT.easing);
  }
  const easeOf = s => (hasLinear ? s.easing : 'cubic-bezier(.2,1,.3,1)');

  /* ---------- measuring ---------- */

  const hero = $('.hero'), about = $('#about'), projects = $('#projects'), contact = $('#contact');
  const m = { vh: 1, hero: 1, abTop: 0, abBot: 0, prTop: 0, prBot: 0, coTop: 0, max: 1 };
  const docTop = el => el.getBoundingClientRect().top + scrollY;
  function measure() {
    m.vh = innerHeight;
    m.hero = hero.offsetHeight;
    m.abTop = docTop(about); m.abBot = m.abTop + about.offsetHeight;
    m.prTop = docTop(projects); m.prBot = m.prTop + projects.offsetHeight;
    m.coTop = docTop(contact);
    m.max = root.scrollHeight - m.vh;
    placeThumb();
    if (window.LunaGL) LunaGL.relayout();
  }

  /* ---------- wheel smoothing ---------- */

  let target = scrollY, wheeling = false;
  function lineHeight(e) { return e.deltaMode === 1 ? 34 : e.deltaMode === 2 ? m.vh : 1; }
  if (fine && !calm) {
    addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey || sheetOpen) return;
      e.preventDefault();
      if (!wheeling) target = scrollY;
      target = clamp(target + e.deltaY * lineHeight(e), 0, m.max);
      wheeling = true;
      tween = null;
    }, { passive: false });
    // Scrollbar, keyboard, find-in-page: real scrolling always wins.
    for (const ev of ['mousedown', 'keydown', 'touchstart']) addEventListener(ev, () => { wheeling = false; tween = null; }, { passive: true });
  }

  // Anchor navigation with a soft, un-springy glide.
  let tween = null;
  function glideTo(y) {
    wheeling = false;
    y = clamp(y, 0, m.max);
    if (calm) { scrollTo(0, y); return; }
    const from = scrollY;
    tween = { from, to: y, t: 0, dur: clamp(.7 + Math.abs(y - from) / m.vh * .13, .7, 1.7) };
  }
  const anchorY = id => {
    if (id === 'top') return 0;
    if (id === 'about') return m.abTop;
    if (id === 'projects') return m.prTop;
    return m.max;
  };
  $$('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    const id = a.getAttribute('href').slice(1);
    glideTo(anchorY(id));
    history.replaceState(null, '', id === 'top' ? location.pathname : '#' + id);
  }));

  /* ---------- nav thumb ---------- */

  const nav = $('.nav'), thumb = $('.nav-thumb'), navLinks = $$('a[data-nav]', nav);
  let activeNav = null;
  function placeThumb() {
    const a = navLinks.find(l => l.dataset.nav === activeNav);
    if (!a) return;
    thumb.style.setProperty('--x', a.offsetLeft + 'px');
    thumb.style.setProperty('--w', a.offsetWidth + 'px');
  }
  function setNav(id) {
    if (id === activeNav) return;
    activeNav = id;
    navLinks.forEach(l => l.classList.toggle('active', l.dataset.nav === id));
    placeThumb();
  }

  /* ---------- reveals ---------- */

  $$('.wall .card').forEach((c, i) => {
    c.classList.add('reveal');
    c.style.setProperty('--d', (i % 3) * 80 + 'ms');
  });
  const revealIO = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); revealIO.unobserve(e.target); }
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: .05 });
  $$('.reveal').forEach(el => revealIO.observe(el));

  /* ---------- feature stack ---------- */

  const featured = $$('.card-feature');
  featured.forEach((c, i) => c.style.setProperty('--i', i));
  function paintStack() {
    for (let i = 0; i < featured.length - 1; i++) {
      const cur = featured[i], next = featured[i + 1];
      const a = cur.getBoundingClientRect(), b = next.getBoundingClientRect();
      const covered = clamp(1 - (b.top - a.top) / (a.height || 1));
      cur.style.setProperty('--s', (1 - covered * .055).toFixed(4));
      const media = cur._copy || (cur._copy = cur.querySelector('.card-open'));
      media.style.filter = covered > .01 ? `brightness(${(1 - covered * .55).toFixed(3)})` : '';
    }
  }

  /* ---------- wall: tilt + light that follows the pointer ---------- */

  if (fine && !calm) {
    $$('.wall .card-open').forEach(el => {
      el.addEventListener('pointermove', e => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        el.style.setProperty('--ry', ((x - .5) * 7).toFixed(2) + 'deg');
        el.style.setProperty('--rx', ((.5 - y) * 7).toFixed(2) + 'deg');
        el.style.setProperty('--gx', (x * 100).toFixed(1) + '%');
        el.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
      });
      el.addEventListener('pointerleave', () => {
        el.style.setProperty('--ry', '0deg');
        el.style.setProperty('--rx', '0deg');
      });
    });
  }
  // Touch has no hover, so colour blooms on whichever card is centred instead.
  if (!fine) {
    const liveIO = new IntersectionObserver(entries => {
      for (const e of entries) e.target.classList.toggle('live', e.isIntersecting);
    }, { rootMargin: '-38% 0px -38% 0px' });
    $$('.card').forEach(c => liveIO.observe(c));
  }

  /* ---------- chain frames: small chrome chains as borders ---------- */

  // A point and tangent at distance s around a rounded rectangle, starting at the top centre and
  // running clockwise. Starting there keeps the chain mirror-symmetric left to right.
  function perimeter(w, h, r) {
    const sx = w - 2 * r, sy = h - 2 * r, arc = Math.PI * r / 2;
    const total = 2 * sx + 2 * sy + 4 * arc;
    const at = s => {
      let d = ((s % total) + total) % total;
      const line = (len, fn) => { if (d <= len) return fn(d); d -= len; return null; };
      const bend = (cx, cy, from) => {
        if (d <= arc) {
          const a = from + d / r;
          return [cx + r * Math.cos(a), cy + r * Math.sin(a), -Math.sin(a), Math.cos(a)];
        }
        d -= arc;
        return null;
      };
      const half = Math.PI / 2;
      return line(sx / 2, t => [w / 2 + t, 0, 1, 0])
        || bend(w - r, r, -half)
        || line(sy, t => [w, r + t, 0, 1])
        || bend(w - r, h - r, 0)
        || line(sx, t => [w - r - t, h, -1, 0])
        || bend(r, h - r, half)
        || line(sy, t => [0, h - r - t, 0, -1])
        || bend(r, r, Math.PI)
        || [r + d, 0, 1, 0];
    };
    return { total, at };
  }

  // Links alternate: a ring seen face-on, then one edge-on, which reads as a short bar.
  function chainPaths(w, h, r, size) {
    const f = n => n.toFixed(2);
    const a = 1.7 * size, R = 1.9 * size, bar = 2.5 * size;
    const { total, at } = perimeter(w, h, r);
    const n = Math.max(Math.round(total / (4.7 * size) / 2) * 2, 4);
    let rings = '', bars = '';
    for (let i = 0; i < n; i++) {
      const [x, y, tx, ty] = at(total * i / n);
      const nx = -ty, ny = tx;
      if (i % 2) {
        bars += `M${f(x - tx * bar)} ${f(y - ty * bar)}L${f(x + tx * bar)} ${f(y + ty * bar)}`;
      } else {
        const P = (u, v) => `${f(x + tx * u + nx * v)} ${f(y + ty * u + ny * v)}`;
        rings += `M${P(a, R)}A${f(R)} ${f(R)} 0 0 0 ${P(a, -R)}L${P(-a, -R)}A${f(R)} ${f(R)} 0 0 0 ${P(-a, R)}Z`;
      }
    }
    return { rings, bars };
  }

  let frameId = 0;
  function chainFrame(host, measureEl, size, radiusEl) {
    const SVG = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'chain-frame');
    svg.setAttribute('aria-hidden', 'true');
    const id = 'chain-chrome-' + frameId++;
    const defs = document.createElementNS(SVG, 'defs');
    const grad = document.createElementNS(SVG, 'linearGradient');
    grad.id = id;
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    grad.setAttribute('x1', '0'); grad.setAttribute('x2', '0');
    [[0, '#ffffff'], [.3, '#b7bec9'], [.52, '#6d7583'], [.68, '#e4e8ed'], [1, '#98a1af']].forEach(([o, c]) => {
      const st = document.createElementNS(SVG, 'stop');
      st.setAttribute('offset', o); st.setAttribute('stop-color', c);
      grad.append(st);
    });
    defs.append(grad);
    const paths = [.85, 1.25].map(sw => {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', `url(#${id})`);
      p.setAttribute('stroke-width', sw * size);
      p.setAttribute('stroke-linecap', 'round');
      return p;
    });
    svg.append(defs, ...paths);
    host.append(svg);

    const draw = () => {
      const w = measureEl.offsetWidth, h = measureEl.offsetHeight;
      if (!w || !h) return;
      const r = Math.min(parseFloat(getComputedStyle(radiusEl).borderTopLeftRadius) || 0, h / 2);
      svg.setAttribute('width', w); svg.setAttribute('height', h);
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      grad.setAttribute('y1', 0); grad.setAttribute('y2', h);
      const { rings, bars } = chainPaths(w, h, r, size);
      paths[0].setAttribute('d', rings);
      paths[1].setAttribute('d', bars);
    };
    draw();
    if (window.ResizeObserver) new ResizeObserver(draw).observe(measureEl);
  }

  chainFrame(nav, nav, .82, nav);
  featured.forEach(c => chainFrame(c, c, 1.15, $('.card-open', c)));
  $$('.wall .card').forEach(c => chainFrame($('.card-open', c), $('.card-media', c), 1, $('.card-media', c)));
  $$('#about .pill, #contact .pill').forEach(p => chainFrame(p, p, .8, p));

  /* ---------- sheet ---------- */

  const sheet = $('#sheet'), panel = $('.sheet-panel'), scrim = $('.sheet-scrim');
  const mediaBox = $('.sheet-media'), poster = $('.sheet-poster'), full = $('img.sheet-full'), clipEl = $('.sheet-video'), bodyBox = $('.sheet-body');
  let sheetOpen = false, phase = 'closed', fromCard = null, anims = [];

  function fromRect(card) {
    // Express the panel as a transform plus clip that land exactly on the card's image.
    const r = $('.card-media', card).getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const mw = p.width, mh = mediaBox.offsetHeight, ph = panel.offsetHeight;
    const s = Math.max(r.width / mw, r.height / mh);
    const w = r.width / s, h = r.height / s;
    const tx = r.left + r.width / 2 - s * mw / 2;
    const ty = r.top + r.height / 2 - s * mh / 2;
    const top = (mh - h) / 2, left = (mw - w) / 2;
    const radius = parseFloat(getComputedStyle($('.card-open', card)).borderTopLeftRadius) || 24;
    return {
      transform: `translate(${tx - p.left}px, ${ty - p.top}px) scale(${s})`,
      clip: `inset(${top}px ${left}px ${ph - top - h}px ${left}px round ${radius / s}px)`
    };
  }
  const openClip = () => {
    const r = parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 0;
    return `inset(0px 0px 0px 0px round ${r}px)`;
  };

  function openSheet(card) {
    if (phase !== 'closed') return;
    phase = 'opening'; sheetOpen = true; fromCard = card;
    root.classList.add('sheet-open');

    const coverSrc = $('.card-media img', card).getAttribute('src');
    const detail = card.dataset.detail;
    mediaBox.style.setProperty('--ratio', card.dataset.ratio || '16/10');
    poster.src = coverSrc;
    mediaBox.classList.remove('ready');
    full.onload = () => mediaBox.classList.add('ready');
    full.removeAttribute('src');
    bodyBox.innerHTML = $('.card-detail', card).innerHTML;
    sheet.scrollTop = 0;
    sheet.showModal();
    sheet.scrollTop = 0;
    // A project shows either a full image or a looping clip.
    const clip = card.dataset.video;
    full.hidden = !!clip;
    clipEl.hidden = !clip;
    if (clip) {
      clipEl.oncanplay = () => mediaBox.classList.add('ready');
      clipEl.controls = calm;
      clipEl.style.objectFit = card.dataset.fit || '';
      clipEl.src = clip;
      if (!calm) clipEl.play().catch(() => { clipEl.controls = true; });
    } else if (detail) {
      full.src = detail;
    }

    const start = fromRect(card);
    const media = $('.card-media', card);
    media.style.visibility = 'hidden';

    if (calm) { media.style.visibility = ''; phase = 'open'; return; }
    anims.forEach(a => a.cancel());
    anims = [
      panel.animate(
        [{ transform: start.transform, clipPath: start.clip }, { transform: 'none', clipPath: openClip() }],
        { duration: SHEET_IN.ms, easing: easeOf(SHEET_IN), fill: 'both' }),
      scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out', fill: 'both' }),
      bodyBox.animate(
        [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'none' }],
        { duration: 700, delay: 120, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' })
    ];
    const opening = anims[0];
    opening.finished.then(() => { if (phase === 'opening') { phase = 'open'; opening.cancel(); } }).catch(() => {});
  }

  function closeSheet() {
    if (phase !== 'open' && phase !== 'opening') return;
    phase = 'closing';
    const card = fromCard, media = $('.card-media', card);
    const done = () => {
      sheet.close();
      media.style.visibility = '';
      root.classList.remove('sheet-open');
      sheetOpen = false; phase = 'closed';
      full.removeAttribute('src');
      clipEl.pause();
      clipEl.removeAttribute('src');
      clipEl.load();
      anims.forEach(a => a.cancel());
      anims = [];
      target = scrollY;
    };
    if (calm) { done(); return; }
    // Start from wherever the panel is right now, so closing can interrupt opening.
    const now = getComputedStyle(panel);
    const liveTransform = now.transform, liveClip = now.clipPath !== 'none' ? now.clipPath : openClip();
    const liveScrim = getComputedStyle(scrim).opacity, liveBody = getComputedStyle(bodyBox).opacity;
    anims.forEach(a => a.cancel());
    const end = fromRect(card);
    const main = panel.animate(
      [{ transform: liveTransform, clipPath: liveClip }, { transform: end.transform, clipPath: end.clip }],
      { duration: SHEET_OUT.ms, easing: easeOf(SHEET_OUT), fill: 'both' });
    anims = [
      main,
      scrim.animate([{ opacity: liveScrim }, { opacity: 0 }], { duration: Math.min(380, SHEET_OUT.ms), easing: 'ease-in', fill: 'both' }),
      bodyBox.animate([{ opacity: liveBody }, { opacity: 0 }], { duration: 160, easing: 'linear', fill: 'both' })
    ];
    main.finished.then(done).catch(done);
  }

  $$('.card').forEach(card => $('.card-open', card).addEventListener('click', () => openSheet(card)));
  $('.sheet-close').addEventListener('click', closeSheet);
  sheet.addEventListener('click', e => { if (e.target === sheet || e.target === scrim) closeSheet(); });
  sheet.addEventListener('cancel', e => { e.preventDefault(); closeSheet(); });

  /* ---------- main loop ---------- */

  const heroPin = $('.hero-pin');
  const st = { hero: 0, veins: 1, stars: 0, caustic: 0, chains: 0, side: 0, scroll: 0, px: 0, py: 0, grow: calm ? 1 : 0 };
  const pointer = { x: 0, y: 0 };
  if (fine && !calm) addEventListener('pointermove', e => {
    pointer.x = e.clientX / innerWidth * 2 - 1;
    pointer.y = e.clientY / innerHeight * 2 - 1;
  }, { passive: true });

  let last = performance.now(), t0 = 0, smoothY = scrollY, lastHeroP = -1;

  function frame(now) {
    requestAnimationFrame(frame);
    const dtMs = now - last;
    const dt = Math.min(dtMs, 64) / 1000;
    last = now;

    if (tween) {
      tween.t = Math.min(tween.t + dt / tween.dur, 1);
      const k = tween.t, e = k < .5 ? 16 * k ** 5 : 1 - (-2 * k + 2) ** 5 / 2;
      scrollTo(0, tween.from + (tween.to - tween.from) * e);
      if (k >= 1) { tween = null; target = scrollY; }
    } else if (wheeling) {
      const y = damp(scrollY, target, 9.5, dt);
      const next = Math.abs(target - y) < .4 ? target : y;
      scrollTo(0, next);
      if (next === target) wheeling = false;
    }

    const y = scrollY;
    smoothY = calm ? y : damp(smoothY, y, 14, dt);
    if (Math.abs(smoothY - y) < .05) smoothY = y;

    // Scroll → scene.
    const vh = m.vh;
    const heroP = clamp(smoothY / Math.max(m.hero - vh, 1));
    // The water's light shows in About, and returns behind the chains at the very end.
    const chainsIn = smooth(m.coTop - vh, m.coTop - vh * .25, smoothY);
    const caustic = Math.max(
      smooth(m.abTop - vh * .9, m.abTop - vh * .1, smoothY) * (1 - smooth(m.abBot - vh * .7, m.abBot - vh * .1, smoothY)),
      chainsIn * .85
    );
    // Reduced motion: the web stays put and simply fades to night as it leaves.
    const leaving = calm ? smooth(0, vh * .9, smoothY) : heroP;
    st.hero = calm ? 0 : heroP;
    st.veins = 1 - smooth(.66, .98, leaving);
    st.caustic = caustic;
    // A few stars are already out behind the moon, and the sky fills in as it leaves.
    st.stars = (.65 + .35 * smooth(.45, .95, leaving)) * (1 - caustic * .72);
    st.chains = chainsIn;
    // Chains creep in from the screen's edges as the first page scrolls away, then stay.
    st.side = smooth(.02, .58, leaving);
    st.scroll = smoothY / vh;
    st.px = damp(st.px, pointer.x, 3.2, dt);
    st.py = damp(st.py, pointer.y, 3.2, dt);

    if (window.LunaGL && !sheetOpen) {
      if (!calm) {
        // The surface condenses out of the dark once the lettering is ready.
        if (!t0 && LunaGL.isReady()) t0 = now;
        const g = t0 ? clamp((now - t0) / 3200) : 0;
        st.grow = 1 - (1 - g) ** 3;
      }
      LunaGL.render(st, calm ? 40 : 40 + now / 1000, dtMs);
    }

    // The caption and scroll cue clear first; the name evaporates in the shader.
    if (heroP !== lastHeroP) {
      lastHeroP = heroP;
      heroPin.style.setProperty('--foot', (1 - smooth(0, .14, heroP)).toFixed(3));
    }

    // Stack depth, only while near it.
    if (y + vh > m.prTop && y < m.prBot) paintStack();

    // Nav.
    const probe = y + vh * .42;
    setNav(probe >= m.coTop ? 'contact' : probe >= m.prTop ? 'projects' : probe >= m.abTop ? 'about' : 'top');
  }

  /* ---------- boot ---------- */

  measure();
  addEventListener('resize', measure);
  if (window.ResizeObserver) new ResizeObserver(measure).observe(document.body);
  addEventListener('load', measure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  setNav('top');
  // Reveal once the type is in, so letters never settle in a fallback font.
  const showPage = () => root.classList.add('loaded');
  Promise.race([
    document.fonts ? document.fonts.load('700 100px Inter').then(() => document.fonts.ready) : Promise.resolve(),
    new Promise(r => setTimeout(r, 1200))
  ]).then(showPage, showPage);
  requestAnimationFrame(frame);
})();
