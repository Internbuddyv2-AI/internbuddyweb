const hamburger = document.querySelector('.hamburger');
const navLinks = document.querySelector('.nav-links');
const loginForm = document.getElementById('login-form');

// Hamburger toggle for mobile nav
hamburger.addEventListener('click', () => {
  navLinks.classList.toggle('active');
});

function redirectAfterLogin() {
  // Check if user has onboarded before
  const hasOnboarded = localStorage.getItem('hasOnboarded');

  if (hasOnboarded === 'true') {
    // Already onboarded, go to homepage
    window.location.href = 'homepage.html';
  } else {
    // First login, go to onboarding and set flag
    localStorage.setItem('hasOnboarded', 'true');
    window.location.href = 'onboarding.html';
  }
}

// Google Sign-In callback handler
function handleCredentialResponse(response) {
  console.log('Encoded JWT ID token:', response.credential);

  // Decode JWT token to get user info
  const base64Url = response.credential.split('.')[1];
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const jsonPayload = decodeURIComponent(
    atob(base64)
      .split('')
      .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join('')
  );

  const user = JSON.parse(jsonPayload);
  console.log('User info:', user);

  alert(`Welcome, ${user.name} (${user.email})! You have successfully logged in with Google.`);

  // TODO: send token to backend for verification and session management

  // Redirect based on onboarding status
  redirectAfterLogin();
}

window.onload = function () {
  google.accounts.id.initialize({
    client_id: '823999548591-g2i76g0es6sk6somflpqtvmrg1de5h9e.apps.googleusercontent.com',
    callback: handleCredentialResponse,
  });

  google.accounts.id.renderButton(document.getElementById('g_id_signin'), {
    theme: 'outline',
    size: 'large',
  });

  // Optionally prompt One Tap sign-in UI
  // google.accounts.id.prompt();
};

// Email/password form submission handling
loginForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  if (!email || !password) {
    alert('Please enter both email and password.');
    return;
  }

  // Simulate backend authentication
  if (email === 'test@example.com' && password === 'password') {
    alert('Email/password login successful.');
    redirectAfterLogin();
  } else {
    alert('Invalid email or password.');
  }
});
