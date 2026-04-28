document.addEventListener("DOMContentLoaded", () => {
    // --- SCROLL REVEAL ANIMATION SYSTEM ---
    const revealElements = document.querySelectorAll('.reveal-on-scroll');

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            // Trigger animation when section is at least 15% visible
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                // Stop watching once animated
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.15 }); 

    // Start watching your section
    revealElements.forEach(element => {
        observer.observe(element);
    });
});






































document.addEventListener("DOMContentLoaded", function() {
    const featSection = document.querySelector('.features');

    if (featSection) {
        const featObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    featSection.classList.add('is-visible');
                    featObserver.unobserve(featSection);
                }
            });
        }, { threshold: 0.15 });

        featObserver.observe(featSection);
    }
});












document.addEventListener("DOMContentLoaded", () => {
    const typeTarget = document.querySelector('.vp-text-primary');
    
    if (typeTarget) {
        const fullText = typeTarget.innerHTML;
        typeTarget.innerHTML = ""; // Clear for typing
        let charIndex = 0;

        function startTyping() {
            if (charIndex < fullText.length) {
                typeTarget.innerHTML += fullText.charAt(charIndex);
                charIndex++;
                setTimeout(startTyping, 35);
            }
        }

        // Trigger only when user scrolls to section
        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                setTimeout(startTyping, 500);
                observer.disconnect();
            }
        }, { threshold: 0.5 });

        observer.observe(document.querySelector('.vp-live-preview'));
    }
});

















document.querySelector('.cu-form').addEventListener('submit', function(e) {
    e.preventDefault();
    const btn = document.querySelector('.cu-submit-btn');
    btn.innerText = "Sent Successfully! ✓";
    btn.style.background = "#10b981";
    this.reset();
});












/* ========================================= */
/* --- ABOUT US SECTION LOGIC --- */
/* ========================================= */

document.addEventListener("DOMContentLoaded", () => {
    const aboutSection = document.querySelector('.au-about-section');
    const aboutImage = document.querySelector('.au-image-wrapper');
    const aboutContent = document.querySelector('.au-content-side');

    if (aboutSection) {
        // 1. Scroll Reveal Observer
        const aboutObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    // Add visibility to the image and text with a slight delay
                    aboutImage.style.opacity = "1";
                    aboutImage.style.transform = "translateX(0)";
                    
                    aboutContent.style.opacity = "1";
                    aboutContent.style.transform = "translateY(0)";
                    
                    // Stop observing once the animation has fired
                    aboutObserver.unobserve(entry.target);
                }
            });
        }, { 
            threshold: 0.2 // Trigger when 20% of the section is visible
        });

        // Initialize the hidden states via JS to ensure they show up if JS is disabled
        aboutImage.style.opacity = "0";
        aboutImage.style.transform = "translateX(-30px)";
        aboutImage.style.transition = "all 0.8s cubic-bezier(0.16, 1, 0.3, 1)";

        aboutContent.style.opacity = "0";
        aboutContent.style.transform = "translateY(20px)";
        aboutContent.style.transition = "all 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.2s";

        aboutObserver.observe(aboutSection);
    }

    // 2. Simple Button Interaction
    const primaryBtn = document.querySelector('.au-primary-btn');
    if (primaryBtn) {
        primaryBtn.addEventListener('click', (e) => {
            console.log("Navigating to Transcription Engine...");
            // The browser will follow the href="presenter.html" automatically
        });
    }
});











document.addEventListener("DOMContentLoaded", () => {
    const cards = document.querySelectorAll('.team-card');
    
    const teamObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                // Trigger animations for all cards in the grid
                cards.forEach((card, index) => {
                    setTimeout(() => {
                        card.style.opacity = "1";
                        card.style.transform = "translateY(0)";
                    }, index * 100);
                });
                teamObserver.disconnect();
            }
        });
    }, { threshold: 0.1 });

    // Initial State for Animation
    cards.forEach(card => {
        card.style.opacity = "0";
        card.style.transform = "translateY(30px)";
        card.style.transition = "opacity 0.8s ease, transform 0.8s ease";
    });

    const targetSection = document.querySelector('.team-section');
    if (targetSection) teamObserver.observe(targetSection);
});
document.querySelector('.ft-logo-dark').addEventListener('click', (e) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
});