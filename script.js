document.addEventListener('DOMContentLoaded', () => {
    // Redirect for navigateButton (to timer/timer.html)
    const navigateButton = document.getElementById('navigateButton');
    if (navigateButton) {
        navigateButton.addEventListener('click', () => {
            window.location.href = 'timer/timer.html';
        });
    } else {
        console.error('Element with ID "navigateButton" not found');
    }

    // Redirect for navigateBut2 (to timer_PC/PC/PC.html)
    const navigateBut2 = document.getElementById('navigateBut2');
    if (navigateBut2) {
        navigateBut2.addEventListener('click', (e) => {
            e.preventDefault();
            console.log('Navigating to timer_PC/PC/PC.html');
            window.location.href = 'timer_PC/PC/PC.html';
        });
    } else {
        console.error('Element with ID "navigateBut2" not found');
    }

    // Form submission
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
        contactForm.addEventListener('submit', (e) => {
            e.preventDefault();
            fetch('/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    'form-name': 'contacto',
                    ...Object.fromEntries(new FormData(e.target))
                }).toString()
            })
            .then(response => {
                if (response.ok) {
                    alert('¡Gracias por tu mensaje! Nos pondremos en contacto pronto.');
                    e.target.reset();
                } else {
                    throw new Error(`Error ${response.status}: ${response.statusText}`);
                }
            })
            .catch(error => {
                console.error('Error en el envío del formulario:', error);
                alert('Hubo un error al enviar tu mensaje. Por favor, intenta de nuevo.');
            });
        });
    } else {
        console.error('Elemento con ID "contactForm" no encontrado');
    }

    // Smooth scroll for nav links
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            const href = link.getAttribute('href');
            if (href && href.startsWith('#')) {
                e.preventDefault();
                const target = document.querySelector(href);
                if (target) {
                    window.scrollTo({
                        top: target.offsetTop,
                        behavior: 'smooth'
                    });
                }
            }
        });
    });
});

window.addEventListener('scroll', () => {
    const backToTopButton = document.getElementById('backToTop');
    backToTopButton.classList.toggle('visible', window.scrollY > 300);
});

document.getElementById('backToTop').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
});