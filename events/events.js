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

// TEMA CLARO/OSCURO (igual que la portada: variables CSS + persistencia)
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
function showNotification(msg) {
    const n = document.getElementById('notification');
    if (!n) return;
    n.textContent = msg;
    n.classList.add('show');
    setTimeout(() => n.classList.remove('show'), 3000);
}

// SCROLL TO TOP
const backToTop = document.getElementById('backToTop');
if (backToTop) {
    window.addEventListener('scroll', () => {
        backToTop.classList.toggle('visible', window.scrollY > 300);
    }, { passive: true });
    backToTop.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

// SCROLL SUAVE PARA ENLACES INTERNOS
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const id = this.getAttribute('href');
        if (!id || id.length < 2) return;
        const target = document.querySelector(id);
        if (target) {
            e.preventDefault();
            window.scrollTo({ top: target.offsetTop - 80, behavior: 'smooth' });
        }
    });
});

// FUNCIONALIDADES ESPECÍFICAS PARA EVENTOS

// Resaltar eventos próximos (en los próximos 30 días)
function highlightUpcomingEvents() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    document.querySelectorAll('.item[itemscope] time[datetime]').forEach(timeEl => {
        const eventDate = new Date(timeEl.getAttribute('datetime'));
        if (isNaN(eventDate)) return;
        const daysUntilEvent = (eventDate - today) / (1000 * 60 * 60 * 24);
        if (daysUntilEvent >= 0 && daysUntilEvent <= 30) {
            const item = timeEl.closest('.item');
            if (item) item.classList.add('event-highlight');
        }
    });
}

document.addEventListener('DOMContentLoaded', highlightUpcomingEvents);
