// PARTÍCULAS (sutiles, con respeto a reduced-motion y rendimiento)
(function initParticles() {
    const canvas = document.getElementById('particles');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) { canvas.style.display = 'none'; return; }

    let particles = [];
    let running = true;

    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(innerWidth * dpr);
        canvas.height = Math.floor(innerHeight * dpr);
        canvas.style.width = innerWidth + 'px';
        canvas.style.height = innerHeight + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        init();
    }

    class Particle {
        constructor() { this.reset(true); }
        reset(initial) {
            this.x = Math.random() * innerWidth;
            this.y = initial ? Math.random() * innerHeight : innerHeight + 10;
            this.size = Math.random() * 2.2 + 0.8;
            this.speedY = -(Math.random() * 1.4 + 0.4);
            this.speedX = Math.random() * 0.8 - 0.4;
            this.color = `hsl(20,100%,${60 + Math.random() * 20}%)`;
        }
        update() {
            this.y += this.speedY;
            this.x += this.speedX;
            if (this.y < -10) this.reset(false);
        }
        draw() {
            ctx.fillStyle = this.color;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    function init() {
        const count = innerWidth < 640 ? 28 : 55;
        particles = [];
        for (let i = 0; i < count; i++) particles.push(new Particle());
    }
    function animate() {
        if (!running) return;
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        for (const p of particles) { p.update(); p.draw(); }
        requestAnimationFrame(animate);
    }
    document.addEventListener('visibilitychange', () => {
        running = !document.hidden;
        if (running) animate();
    });
    let resizeT;
    window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(resize, 150); });
    resize();
    animate();
})();

// SONIDO DE CLICK (WebAudio, sin dependencias externas)
let audioCtx = null;
function playClick() {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(90, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(320, audioCtx.currentTime + 0.28);
        gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
        osc.start(); osc.stop(audioCtx.currentTime + 0.32);
    } catch (e) { /* audio no disponible, ignorar */ }
}

// BOTONES DE NAVEGACIÓN (solo los que tienen data-url; el submit del form queda fuera)
document.querySelectorAll('.btn[data-url]').forEach(btn => {
    btn.addEventListener('click', () => {
        playClick();
        btn.style.transform = 'scale(0.96)';
        setTimeout(() => { window.location.href = btn.dataset.url; }, 220);
    });
});

// TEMA CLARO/OSCURO (con guarda por si el botón no existe)
const toggle = document.getElementById('themeToggle');
function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (theme === 'light') {
        document.documentElement.style.setProperty('--dark', '#f8fafc');
        document.documentElement.style.setProperty('--light', '#0f172a');
        document.documentElement.style.setProperty('--text-secondary', '#64748b');
        document.documentElement.style.setProperty('--card-bg', 'rgba(0, 0, 0, 0.06)');
        document.documentElement.style.setProperty('--hover-bg', 'rgba(255, 69, 0, 0.1)');
        document.documentElement.style.setProperty('--border', 'rgba(255, 69, 0, 0.3)');
        if (toggle) toggle.innerHTML = '<i class="fas fa-sun" aria-hidden="true"></i>';
    } else {
        document.documentElement.style.setProperty('--dark', '#0f172a');
        document.documentElement.style.setProperty('--light', '#f8fafc');
        document.documentElement.style.setProperty('--text-secondary', '#cbd5e1');
        document.documentElement.style.setProperty('--card-bg', 'rgba(255, 255, 255, 0.06)');
        document.documentElement.style.setProperty('--hover-bg', 'rgba(255, 69, 0, 0.1)');
        document.documentElement.style.setProperty('--border', 'rgba(255, 69, 0, 0.2)');
        if (toggle) toggle.innerHTML = '<i class="fas fa-moon" aria-hidden="true"></i>';
    }
    try { localStorage.setItem('theme', theme); } catch (e) {}
}
if (toggle) {
    toggle.addEventListener('click', () => {
        let current = 'dark';
        try { current = localStorage.getItem('theme') || 'dark'; } catch (e) {}
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });
}
(function initTheme() {
    let saved = 'dark';
    try {
        saved = localStorage.getItem('theme')
            || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    } catch (e) {}
    applyTheme(saved);
})();

// TRADUCTOR (expuesto globalmente para el callback de Google)
window.googleTranslateElementInit = function () {
    try {
        new google.translate.TranslateElement({ pageLanguage: 'es', autoDisplay: false }, 'google_translate_element');
    } catch (e) {}
};

// NOTIFICACIONES
function show(msg) {
    const n = document.getElementById('notification');
    if (!n) return;
    n.textContent = msg;
    n.classList.add('show');
    setTimeout(() => n.classList.remove('show'), 3000);
}

// FORMULARIO DE CONTACTO (con guarda si no hay form en la página)
const contactForm = document.getElementById('contactForm');
if (contactForm) {
    let contactSubmitting = false;
    contactForm.addEventListener('submit', async e => {
        e.preventDefault();
        if (contactSubmitting) return;

        const form = e.currentTarget || e.target;
        const fd = new FormData(form);
        const honeypot = String(fd.get('bot-field') || '').trim();
        if (honeypot) {
            show('No se pudo validar el formulario. Revisa los campos e inténtalo de nuevo.');
            return;
        }

        const payload = {
            nombre: String(fd.get('nombre') || '').trim(),
            email: String(fd.get('email') || '').trim(),
            mensaje: String(fd.get('mensaje') || '').trim()
        };
        const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email);
        if (!payload.nombre || payload.nombre.length > 100
            || !emailIsValid || payload.email.length > 254
            || !payload.mensaje || payload.mensaje.length > 5000) {
            show('Revisa los campos e inténtalo de nuevo.');
            return;
        }
        if (typeof fetch !== 'function') {
            show('No se pudo guardar tu mensaje. Inténtalo de nuevo.');
            return;
        }

        contactSubmitting = true;
        const submitButton = form.querySelector('button[type="submit"]');
        if (submitButton) submitButton.disabled = true;
        show('Enviando mensaje…');
        try {
            const response = await fetch('/api/contact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error('Contact request was rejected');
            show('¡Mensaje recibido! Gracias por escribirnos.');
            form.reset();
        } catch (error) {
            show('No se pudo guardar tu mensaje. Inténtalo de nuevo.');
        } finally {
            contactSubmitting = false;
            if (submitButton) submitButton.disabled = false;
        }
    });
}

// SCROLL TO TOP
const btt = document.getElementById('backToTop');
if (btt) {
    window.addEventListener('scroll', () => btt.classList.toggle('visible', window.scrollY > 300), { passive: true });
    btt.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

// SCROLL SUAVE
document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
        const id = a.getAttribute('href');
        if (id.length < 2) return;
        const t = document.querySelector(id);
        if (t) { e.preventDefault(); window.scrollTo({ top: t.offsetTop - 80, behavior: 'smooth' }); }
    });
});
