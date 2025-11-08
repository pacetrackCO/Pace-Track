// PARTÍCULAS DE FUEGO (sutiles)
const canvas = document.getElementById('particles');
const ctx = canvas.getContext('2d');
canvas.width = innerWidth; canvas.height = innerHeight;
let particles = [];

class Particle {
    constructor() {
        this.x = Math.random() * canvas.width;
        this.y = canvas.height + 10;
        this.size = Math.random() * 3 + 1;
        this.speedY = -(Math.random() * 2 + 0.5);
        this.speedX = Math.random() * 1 - 0.5;
        this.color = `hsl(20,100%,${60 + Math.random() * 20}%)`;
    }
    update() {
        this.y += this.speedY;
        this.x += this.speedX;
        if (this.y < -10) this.y = canvas.height + 10;
    }
    draw() {
        ctx.fillStyle = this.color;
        ctx.shadowBlur = 10;
        ctx.shadowColor = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
    }
}
function init() { particles = []; for (let i = 0; i < 60; i++) particles.push(new Particle()); }
function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(animate);
}
init(); animate();
window.addEventListener('resize', () => { canvas.width = innerWidth; canvas.height = innerHeight; init(); });

// BOTONES + SONIDO MOTO
document.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const audio = new Audio('https://assets.mixkit.co/sfx/preview/mixkit-race-car-accelerating-1709.mp3');
        audio.volume = 0.25; audio.play();
        document.body.style.transform = 'scale(0.97)';
        setTimeout(() => location.href = btn.dataset.url, 350);
    });
});

// TEMA CLARO/OSCURO
const toggle = document.getElementById('themeToggle');
toggle.addEventListener('click', () => {
    const isDark = document.body.style.background === 'var(--dark)';
    document.body.style.background = isDark ? 'var(--light)' : 'var(--dark)';
    document.body.style.color = isDark ? '#000' : 'var(--light)';
    toggle.textContent = isDark ? 'SUN' : 'MOON';
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
});
if (localStorage.getItem('theme') === 'light') {
    document.body.style.background = 'var(--light)';
    document.body.style.color = '#000';
    toggle.textContent = 'SUN';
}

// TRADUCTOR
function googleTranslateElementInit() {
    new google.translate.TranslateElement({pageLanguage:'es',autoDisplay:false},'google_translate_element');
}

// NOTIFICACIONES
function show(msg) {
    const n = document.getElementById('notification');
    n.textContent = msg;
    n.classList.add('show');
    setTimeout(() => n.classList.remove('show'), 3000);
}

// FORMULARIO NETLIFY
document.getElementById('contactForm').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fd).toString()
    })
    .then(() => { show('¡Enviado!'); e.target.reset(); })
    .catch(() => show('Error. Inténtalo de nuevo.'));
});

// SCROLL
const btt = document.getElementById('backToTop');
window.addEventListener('scroll', () => btt.classList.toggle('visible', scrollY > 300));
btt.addEventListener('click', () => window.scrollTo({top:0,behavior:'smooth'}));

// SCROLL SUAVE
document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
        const t = document.querySelector(a.getAttribute('href'));
        if (t) { e.preventDefault(); window.scrollTo({top:t.offsetTop-80,behavior:'smooth'}); }
    });
});