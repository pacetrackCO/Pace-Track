// PARTÍCULAS DE FUEGO (sutiles)
const canvas = document.getElementById('particles');
const ctx = canvas.getContext('2d');
canvas.width = innerWidth;
canvas.height = innerHeight;
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

function initParticles() {
    particles = [];
    for (let i = 0; i < 60; i++) {
        particles.push(new Particle());
    }
}

function animateParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
        p.update();
        p.draw();
    });
    requestAnimationFrame(animateParticles);
}

// Inicializar partículas
initParticles();
animateParticles();

// Redimensionar canvas cuando cambie el tamaño de la ventana
window.addEventListener('resize', () => {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    initParticles();
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

// Aplicar tema guardado
if (localStorage.getItem('theme') === 'light') {
    document.body.style.background = 'var(--light)';
    document.body.style.color = '#000';
    toggle.textContent = 'SUN';
}

// TRADUCTOR
function googleTranslateElementInit() {
    new google.translate.TranslateElement({
        pageLanguage: 'es',
        autoDisplay: false
    }, 'google_translate_element');
}

// NOTIFICACIONES
function showNotification(msg) {
    const n = document.getElementById('notification');
    n.textContent = msg;
    n.classList.add('show');
    setTimeout(() => n.classList.remove('show'), 3000);
}

// SCROLL TO TOP
const backToTop = document.getElementById('backToTop');
window.addEventListener('scroll', () => {
    backToTop.classList.toggle('visible', window.scrollY > 300);
});

backToTop.addEventListener('click', () => {
    window.scrollTo({
        top: 0,
        behavior: 'smooth'
    });
});

// SCROLL SUAVE PARA ENLACES INTERNOS
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            window.scrollTo({
                top: target.offsetTop - 80,
                behavior: 'smooth'
            });
        }
    });
});

// FUNCIONALIDADES ESPECÍFICAS PARA EVENTOS

// Resaltar eventos próximos
function highlightUpcomingEvents() {
    const today = new Date();
    const eventItems = document.querySelectorAll('.item[itemscope]');
    
    eventItems.forEach(item => {
        const dateElement = item.querySelector('time');
        if (dateElement) {
            const eventDate = new Date(dateElement.getAttribute('datetime'));
            
            // Si el evento es en los próximos 30 días, resaltarlo
            const daysUntilEvent = (eventDate - today) / (1000 * 60 * 60 * 24);
            if (daysUntilEvent >= 0 && daysUntilEvent <= 30) {
                item.classList.add('event-highlight');
            }
        }
    });
}

// Filtrar eventos por estado
function filterEvents(status) {
    const eventItems = document.querySelectorAll('.item[itemscope]');
    
    eventItems.forEach(item => {
        const dateElement = item.querySelector('time');
        if (dateElement) {
            const eventDate = new Date(dateElement.getAttribute('datetime'));
            const today = new Date();
            
            let showItem = false;
            
            if (status === 'upcoming' && eventDate >= today) {
                showItem = true;
            } else if (status === 'past' && eventDate < today) {
                showItem = true;
            } else if (status === 'all') {
                showItem = true;
            }
            
            item.style.display = showItem ? 'block' : 'none';
        }
    });
}

// Inicializar funcionalidades cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
    highlightUpcomingEvents();
    
    // Agregar botones de filtro si no existen
    if (!document.querySelector('.event-filters')) {
        const filters = document.createElement('div');
        filters.className = 'event-filters';
        filters.innerHTML = `
            <div style="text-align: center; margin-bottom: 2rem;">
            </div>
        `;
        
        const eventosSection = document.querySelector('#proximos-eventos');
        if (eventosSection) {
            eventosSection.parentNode.insertBefore(filters, eventosSection);
            
            // Agregar event listeners a los botones de filtro
            document.querySelectorAll('.filter-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const filter = btn.getAttribute('data-filter');
                    filterEvents(filter);
                    
                    // Actualizar estado activo de los botones
                    document.querySelectorAll('.filter-btn').forEach(b => {
                        b.style.opacity = b === btn ? '1' : '0.7';
                    });
                });
            });
        }
    }
});