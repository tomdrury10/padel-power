// nav scroll state
const hd = document.querySelector('header');
addEventListener('scroll', () => hd.classList.toggle('scrolled', scrollY > 40), { passive: true });
hd.classList.toggle('scrolled', scrollY > 40);

// mobile menu
const mm = document.getElementById('mmenu');
const burger = document.getElementById('burger');
if (mm && burger) {
  burger.onclick = () => mm.classList.add('open');
  document.getElementById('mclose').onclick = () => mm.classList.remove('open');
  mm.querySelectorAll('a').forEach(a => a.addEventListener('click', () => mm.classList.remove('open')));
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
if (new URLSearchParams(location.search).has('flat')) {
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
  const auto = () => { clearInterval(timer); timer = setInterval(() => go(i + 1), 4500); };
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
const heroVid = document.querySelector('.hero video');
if (heroVid) {
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
