/* canonical domain: bounce any legacy host (GitHub Pages mirror, vercel.app)
   onto www.padelpower.uk, preserving path and query so old SMS links work */
(function () {
  var h = location.hostname;
  if (h === 'tomdrury10.github.io' || h === 'padel-power-demo.vercel.app') {
    location.replace('https://www.padelpower.uk' +
      location.pathname.replace(/^\/padel-power/, '') + location.search + location.hash);
  }
})();

// honour the visitor's reduced-motion setting everywhere below
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// announcement bar across the top of every public page
(function () {
  const header = document.querySelector('header');
  if (!header || header.querySelector('.announce')) return;
  const css = document.createElement('style');
  css.textContent = `
    header .announce{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px 18px;
      padding:9px var(--pad);background:var(--blue);color:var(--ink);
      font-family:var(--mono);font-size:11.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;text-align:center}
    header .announce b{font-weight:700}
    header .announce a{color:var(--ink);text-decoration:underline;text-underline-offset:3px;white-space:nowrap}
    header .announce a:hover,header .announce a:focus-visible{text-decoration-thickness:2px}
    @media (max-width:720px){header .announce b{display:none}}
    .page-hero{padding-top:clamp(206px,calc(24vh + 36px),286px)}
    @media (max-width:820px){.page-hero{padding-top:176px}}`;
  document.head.appendChild(css);
  const bar = document.createElement('div');
  bar.className = 'announce';
  bar.innerHTML = '<b>Pilates and the Gym are open · Kids Zone opens Sat 26 Sept</b><a href="/pilates/">Book Pilates →</a><a href="/gym/">Join the Gym →</a><a href="/kids-zone/">Book the Kids Zone →</a>';
  header.prepend(bar);
})();

// nav scroll state
const hd = document.querySelector('header');
addEventListener('scroll', () => hd.classList.toggle('scrolled', scrollY > 40), { passive: true });
hd.classList.toggle('scrolled', scrollY > 40);

// mobile menu
const mm = document.getElementById('mmenu');
const burger = document.getElementById('burger');
if (mm && burger) {
  const mclose = document.getElementById('mclose');
  burger.setAttribute('aria-expanded', 'false');
  burger.setAttribute('aria-controls', 'mmenu');
  mm.setAttribute('role', 'dialog');
  mm.setAttribute('aria-modal', 'true');
  mm.setAttribute('aria-label', 'Menu');
  const focusables = () => [...mm.querySelectorAll('button, a[href]')].filter(el => el.offsetParent !== null || mm.classList.contains('open'));
  const openMenu = () => {
    mm.classList.add('open');
    burger.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    (mclose || focusables()[0])?.focus();
  };
  const closeMenu = (restore = true) => {
    if (!mm.classList.contains('open')) return;
    mm.classList.remove('open');
    burger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    if (restore) burger.focus();
  };
  burger.onclick = openMenu;
  if (mclose) mclose.onclick = () => closeMenu();
  mm.querySelectorAll('a').forEach(a => a.addEventListener('click', () => closeMenu(false)));
  document.addEventListener('keydown', e => {
    if (!mm.classList.contains('open')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    if (e.key !== 'Tab') return;
    // keep focus inside the open menu
    const f = focusables();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

// duplicate marquee tracks for seamless loop
document.querySelectorAll('[data-marquee]').forEach(el => { el.innerHTML += el.innerHTML; });

// scroll reveals, staggered per batch
const io = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      const el = e.target;
      const siblings = [...el.parentElement.children].filter(c => c.classList.contains('rv') && !c.classList.contains('in'));
      const idx = siblings.indexOf(el);
      el.style.transitionDelay = (Math.max(idx, 0) * .08) + 's';
      el.classList.add('in');
      io.unobserve(el);
    }
  });
}, { threshold: .15, rootMargin: '0px 0px -40px 0px' });
// safety net: reveal anything the viewport has already passed (instant anchor jumps skip the observer)
const revealPassed = () => {
  document.querySelectorAll('.rv:not(.in)').forEach(el => {
    if (el.getBoundingClientRect().top < innerHeight * 0.92) el.classList.add('in');
  });
};
let rvTick = false;
addEventListener('scroll', () => {
  if (rvTick) return; rvTick = true;
  requestAnimationFrame(() => { revealPassed(); rvTick = false; });
}, { passive: true });
addEventListener('hashchange', () => setTimeout(revealPassed, 60));
addEventListener('load', () => setTimeout(revealPassed, 120));

if (reduceMotion || new URLSearchParams(location.search).has('flat')) {
  document.documentElement.classList.add('flat');
  document.querySelectorAll('.rv').forEach(el => el.classList.add('in'));
} else {
  document.querySelectorAll('.rv').forEach(el => io.observe(el));
}

// photo carousels
document.querySelectorAll('[data-carousel]').forEach(car => {
  const track = car.querySelector('.car-track');
  const slides = track.children.length;
  const dots = car.querySelectorAll('.car-dot');
  let i = 0, timer;
  const go = n => {
    i = (n + slides) % slides;
    track.style.transform = `translateX(-${i * 100}%)`;
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
  };
  const auto = () => { clearInterval(timer); if (reduceMotion) return; timer = setInterval(() => go(i + 1), 4500); };
  car.querySelector('.car-prev').addEventListener('click', () => { go(i - 1); auto(); });
  car.querySelector('.car-next').addEventListener('click', () => { go(i + 1); auto(); });
  dots.forEach((d, k) => d.addEventListener('click', () => { go(k); auto(); }));
  car.addEventListener('mouseenter', () => clearInterval(timer));
  car.addEventListener('mouseleave', auto);
  let sx = null;
  car.addEventListener('touchstart', e => sx = e.touches[0].clientX, { passive: true });
  car.addEventListener('touchend', e => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 40) { go(i + (dx < 0 ? 1 : -1)); auto(); }
    sx = null;
  }, { passive: true });
  go(0); auto();
});

// verification helper: ?jump=<section-id> scrolls instantly (used for static captures)
const jumpTo = new URLSearchParams(location.search).get('jump');
if (jumpTo) {
  const el = document.getElementById(jumpTo);
  if (el) setTimeout(() => el.scrollIntoView({ behavior: 'instant' }), 400);
}

// Safari/iOS: force hero video playback (attributes alone are not always honoured)
// The source is chosen here: a 720p file on phones, the full one on larger
// screens, and no video at all (poster only) for reduced motion or data saver.
const heroVid = document.querySelector('.hero video');
const heroSrc = heroVid && (matchMedia('(max-width: 700px)').matches
  ? (heroVid.dataset.srcMobile || heroVid.dataset.src)
  : heroVid.dataset.src);
const saveData = !!(navigator.connection && navigator.connection.saveData);
if (heroVid && (reduceMotion || saveData || !heroSrc)) {
  heroVid.removeAttribute('autoplay');
} else if (heroVid) {
  heroVid.src = heroSrc;
  heroVid.muted = true;
  heroVid.defaultMuted = true;
  heroVid.setAttribute('muted', '');
  const tryPlay = () => { const p = heroVid.play(); if (p) p.catch(() => {}); };
  tryPlay();
  addEventListener('touchstart', tryPlay, { once: true, passive: true });
  addEventListener('click', tryPlay, { once: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tryPlay(); });
  heroVid.addEventListener('loadedmetadata', tryPlay);
}


// ---------------- cookie choice for Google Analytics and Microsoft Clarity ----------------
// Every page starts with analytics consent denied (see the gtag snippet in
// each page head). Nothing is stored by Google until the visitor accepts
// here; the choice is kept in this browser and can be changed from the
// footer link at any time.
(function () {
  const KEY = 'pp_consent';
  const read = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const save = v => { try { localStorage.setItem(KEY, v); } catch (e) {} };
  // Microsoft Clarity (session recordings and heatmaps) loads only after a yes
  const clarity = () => {
    if (window.clarity) return;
    (function(c,l,a,r,i,t,y){
      c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
      t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
      y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", "yjedl5vk4h");
  };
  const apply = v => {
    if (typeof gtag === 'function') gtag('consent', 'update', { analytics_storage: v === 'granted' ? 'granted' : 'denied' });
    if (v === 'granted') clarity();
    else if (typeof window.clarity === 'function') window.clarity('consent', false);
  };
  let box = null;
  const close = () => { if (box) { box.remove(); box = null; } };
  const show = () => {
    if (box) return;
    box = document.createElement('div');
    box.className = 'ck';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-live', 'polite');
    box.setAttribute('aria-label', 'Cookie choices');
    box.innerHTML = '<p>We use Google Analytics and Microsoft Clarity to see how the site is used. They set cookies only if you say yes. <a href="/privacy-policy/">Privacy policy</a></p>'
      + '<div class="ck-btns"><button type="button" class="btn btn-blue" data-ck="granted">Accept analytics</button>'
      + '<button type="button" class="btn btn-ghost" data-ck="denied">No thanks</button></div>';
    box.querySelectorAll('[data-ck]').forEach(b => b.addEventListener('click', () => {
      save(b.dataset.ck); apply(b.dataset.ck); close();
    }));
    document.body.appendChild(box);
  };
  const choice = read();
  if (choice === 'granted' || choice === 'denied') apply(choice); else show();
  // footer link to change the choice later
  const priv = document.querySelector('footer a[href$="privacy-policy/"]');
  if (priv) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ck-link';
    btn.textContent = 'Cookie choices';
    btn.addEventListener('click', show);
    priv.insertAdjacentElement('afterend', btn);
  }
})();
