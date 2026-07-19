import { CONFIG, API } from "../config.js";

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const loginBtn = document.getElementById('loginBtn');
  const errorMessage = document.getElementById('errorMessage');
  const loadingSpinner = document.getElementById('loadingSpinner');

  usernameInput.focus();

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      showError('Please enter both username and password');
      return;
    }

    try {
      loginForm.style.display = 'none';
      loadingSpinner.style.display = 'block';
      errorMessage.style.display = 'none';

      const response = await fetch(API.LOGIN, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        await chrome.storage.local.set({
          [CONFIG.TOKEN_KEY]: data.token,
          [CONFIG.USER_KEY]: {
            username: username,
            name: data.jobApplierName,
            jobapplierId: data.jobapplierId,
            expiresAt: Date.now() + (data.expiresIn * 1000)
          }
        });

        window.location.href = '../popup/popup.html';
      } else {
        showError(data.message || 'Invalid credentials');
        loginForm.style.display = 'block';
        loadingSpinner.style.display = 'none';
      }
    } catch (error) {
      console.error('Login error:', error);
      showError('Network error. Please check your connection.');
      loginForm.style.display = 'block';
      loadingSpinner.style.display = 'none';
    }
  });

  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
    setTimeout(() => {
      errorMessage.style.display = 'none';
    }, 5000);
  }
});
