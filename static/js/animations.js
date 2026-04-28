document.addEventListener("DOMContentLoaded", () => {
    const h1 = document.querySelector('.hero-content h1');
    if (!h1) return; 
    
    const originalHTML = h1.innerHTML;
    h1.innerHTML = '';
    
    let i = 0;
    let isTag = false;
    let currentText = '';

    function typeWriter() {
        if (i < originalHTML.length) {
            // Instantly skip over HTML tags like <br> so they don't print on screen
            if (originalHTML.charAt(i) === '<') isTag = true;

            currentText += originalHTML.charAt(i);
            h1.innerHTML = currentText + '<span class="typing-cursor"></span>';

            if (originalHTML.charAt(i) === '>') isTag = false;

            i++;
            // 40ms typing speed, 0ms if it's a hidden HTML tag
            let delay = isTag ? 0 : 50; 
            setTimeout(typeWriter, delay);
        } else {
            // Typing complete! Add class to trigger CSS cascade animations
            h1.innerHTML = currentText; 
            document.body.classList.add('typing-done');
        }
    }

    // Start typing 400ms after the page loads
    setTimeout(typeWriter, 400); 
});


