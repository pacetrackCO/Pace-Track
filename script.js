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

    // Redirect for navigateBut2 (to timer_PC/timer.html)
    const navigateBut2 = document.getElementById('navigateBut2');
    if (navigateBut2) {
        navigateBut2.addEventListener('click', (e) => {
            e.preventDefault(); // Prevent default behavior if it's an <a> or form button
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
            body: new URLSearchParams(new FormData(e.target)).toString()
        })
        .then(() => {
            alert('Thank you for your message! We will get back to you soon.');
            e.target.reset();
        })
        .catch((error) => {
            console.error('Form submission error:', error);
            alert('There was an error submitting your message. Please try again.');
        });
    });
} else {
    console.error('Element with ID "contactForm" not found');
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