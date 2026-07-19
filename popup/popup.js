import { CONFIG, API } from "../config.js";

let currentToken = null;
let currentUser = null;

document.addEventListener('DOMContentLoaded', async () => {
  await initialize();
});

async function initialize() {
  const loadingState = document.getElementById('loadingState');
  const studentsContent = document.getElementById('studentsContent');
  const errorMessage = document.getElementById('errorMessage');

  try {
    const isAuthenticated = await checkAuth();
    if (!isAuthenticated) {
      window.location.href = '../auth/login.html';
      return;
    }

    // ===== VERSION CHECK =====
    const versionOk = await checkVersion();
    if (!versionOk) return; // Blocked by version modal

    await loadUserData();
    await loadStudentsSummary();
    loadingState.style.display = 'none';
    studentsContent.style.display = 'block';

  } catch (error) {
    console.error('Initialization error:', error);
    loadingState.style.display = 'none';
    showError('Failed to load students. Please try again.');
  }

  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
}

async function checkVersion() {
  try {
    const resp = await fetch(`${API.VERSION_CHECK}?version=${CONFIG.EXTENSION_VERSION}`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    const data = await resp.json();

    if (!data.upToDate) {
      showVersionBlock(data.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Version check failed:', e);
    return true; // Fail open — don't block if check fails
  }
}

function showVersionBlock(message) {
  document.getElementById('loadingState').style.display = 'none';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:10px;width:100%;max-width:380px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
      <div style="background:#c0392b;color:#fff;padding:16px 20px;font-size:15px;font-weight:700;">
        ⛔ Extension Outdated
      </div>
      <div style="padding:20px;">
        <p style="font-size:14px;color:#000;line-height:1.6;">${message}</p>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function checkAuth() {
  const result = await chrome.storage.local.get([CONFIG.TOKEN_KEY, CONFIG.USER_KEY]);
  if (!result[CONFIG.TOKEN_KEY] || !result[CONFIG.USER_KEY]) return false;

  const userData = result[CONFIG.USER_KEY];
  if (userData.expiresAt < Date.now()) {
    await chrome.storage.local.clear();
    return false;
  }

  currentToken = result[CONFIG.TOKEN_KEY];
  currentUser = userData;
  return true;
}

async function loadUserData() {
  document.getElementById('userName').textContent = currentUser.name || currentUser.username;
}

async function loadStudentsSummary() {
  try {
    const resp = await fetch(API.STUDENTS_SUMMARY, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });

    if (!resp.ok) {
      if (resp.status === 401) {
        await chrome.storage.local.clear();
        window.location.href = '../auth/login.html';
        return;
      }
      throw new Error('Failed to fetch students summary');
    }

    const data = await resp.json();
    if (data.success) {
      displayStudents(data.students || []);
    }
  } catch (error) {
    console.error('Error loading students summary:', error);
    showError('Failed to load students');
  }
}
function showScreenshotConfirmModal(studentName) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:100%;max-width:360px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
        <div style="background:#000;color:#fff;padding:14px 20px;font-size:14px;font-weight:700;border-left:5px solid #e67e22;">
          📸 Confirm Screenshot Submission
        </div>
        <div style="padding:18px 20px;">
          <p style="font-size:13px;color:#000;margin:0 0 14px;line-height:1.5;">
            You are confirming that you have submitted all screenshots for <strong>${studentName}</strong> in the designated group.
          </p>
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px;color:#000;font-weight:600;">
            <input type="checkbox" id="screenshotConfirmCheck"
              style="width:15px;height:15px;flex-shrink:0;margin-top:2px;accent-color:#000;cursor:pointer;" />
            <span>I have submitted the screenshot PDF for this student in the group.</span>
          </label>
        </div>
        <div style="padding:0 20px 18px;display:flex;gap:10px;">
          <button id="screenshotCancelBtn" style="flex:1;padding:10px;background:#fff;color:#000;border:2px solid #000;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;">Cancel</button>
          <button id="screenshotConfirmBtn" style="flex:1;padding:10px;background:#ccc;color:#888;border:none;border-radius:7px;font-size:13px;font-weight:700;cursor:not-allowed;" disabled>Confirm</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const check = overlay.querySelector('#screenshotConfirmCheck');
    const confirmBtn = overlay.querySelector('#screenshotConfirmBtn');
    const cancelBtn = overlay.querySelector('#screenshotCancelBtn');

    check.addEventListener('change', () => {
      confirmBtn.disabled = !check.checked;
      confirmBtn.style.background = check.checked ? '#000' : '#ccc';
      confirmBtn.style.color = check.checked ? '#fff' : '#888';
      confirmBtn.style.cursor = check.checked ? 'pointer' : 'not-allowed';
    });

    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve(false);
    });

    confirmBtn.addEventListener('click', () => {
      if (!check.checked) return;
      document.body.removeChild(overlay);
      resolve(true);
    });
  });
}
function displayStudents(students) {
  const studentsList = document.getElementById('studentsList');
  studentsList.innerHTML = '';

  if (students.length === 0) {
    studentsList.innerHTML = '<div style="padding: 40px 20px; text-align: center; color: #666;">No students assigned</div>';
    return;
  }

  // Applier header status dot
  const statuses = students.map(s => s.completionStatus || 'unknown');
  let dotColor = '#27ae60';
  if (statuses.some(s => s === 'unknown')) dotColor = '#e74c3c';
  else if (statuses.some(s => s === 'incomplete')) dotColor = '#e67e22';

  const headerLeft = document.querySelector('.header-left');
  if (headerLeft) {
    const existingDot = headerLeft.querySelector('.header-status-dot');
    if (existingDot) existingDot.remove();
    const dot = document.createElement('span');
    dot.className = 'header-status-dot';
    dot.style.background = dotColor;
    dot.title = statuses.every(s => s === 'complete') ? 'All students complete' :
                statuses.some(s => s === 'unknown') ? 'Some students unknown' : 'Some students incomplete';
    headerLeft.appendChild(dot);
  }

  students.forEach(student => {
    const completionStatus = student.completionStatus || 'unknown';
    const screenshotNeeded = student.screenshotNeeded === true;
    const showScreenshotCheckbox = completionStatus === 'complete' && screenshotNeeded;

    const studentItem = document.createElement('div');
    studentItem.className = `student-item status-${completionStatus}`;

    const priorityClass = student.priority === 'High' ? 'priority-high' : '';

    const statusBadgeStyle = completionStatus === 'complete'
      ? 'background:#e6f9ee;color:#1a7a3f;border:1.5px solid #27ae60;'
      : completionStatus === 'incomplete'
      ? 'background:#fff3e0;color:#b85c00;border:1.5px solid #e67e22;'
      : 'background:#fff0f0;color:#a00;border:1.5px solid #e74c3c;';

    const statusLabel = completionStatus === 'complete' ? '✓ Complete'
      : completionStatus === 'incomplete' ? '● Incomplete'
      : '? Unknown';

    studentItem.innerHTML = `
      <div class="student-info">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <div class="student-name" style="margin-bottom:0;">${student.fullName}</div>
          <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;${statusBadgeStyle}">${statusLabel}</span>
        </div>
        <div class="student-email">${student.email}</div>
        <div class="student-stats">Jobs Pending: ${student.jobsCount || 0}</div>
        ${showScreenshotCheckbox ? `
          <div class="screenshot-row" onclick="event.stopPropagation()">
            <label>
              <input type="checkbox" class="screenshot-check" data-email="${student.email}" />
              Submit screenshots for this student
            </label>
          </div>
        ` : ''}
      </div>
      <div class="priority-badge ${priorityClass}">
        Priority: ${student.priority || 'Normal'}
      </div>
    `;

    if (showScreenshotCheckbox) {
      const checkbox = studentItem.querySelector('.screenshot-check');
      checkbox.addEventListener('change', async (e) => {
        e.stopPropagation();
        if (checkbox.checked) {
          checkbox.checked = false;
          const confirmed = await showScreenshotConfirmModal(student.fullName);
          if (!confirmed) return;
          await submitScreenshot(student.email, checkbox, studentItem);
        }
      });
    }

    studentItem.addEventListener('click', () => selectStudent(student));
    studentsList.appendChild(studentItem);
  });
}


async function submitScreenshot(studentEmail, checkbox, cardEl) {
  checkbox.disabled = true;

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); // YYYY-MM-DD CST

  try {
    const resp = await fetch(API.SUBMIT_SCREENSHOT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: studentEmail, date: today })
    });

    const data = await resp.json();

    if (data.success) {
      // Keep green border, update screenshot row to show submitted
      const screenshotRow = cardEl.querySelector('.screenshot-row');
      if (screenshotRow) {
        screenshotRow.innerHTML = '<span style="font-size:12px;color:#27ae60;font-weight:600;">✓ Screenshots submitted</span>';
      }
    } else {
      checkbox.disabled = false;
      checkbox.checked = false;
    }
  } catch (e) {
    console.error('Submit screenshot error:', e);
    checkbox.disabled = false;
    checkbox.checked = false;
  }
}

async function selectStudent(student) {
  try {
    await chrome.storage.local.set({ [CONFIG.CURRENT_STUDENT_KEY]: student });
    const currentWindow = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: currentWindow.id });
  } catch (error) {
    console.error('Error opening side panel:', error);
    window.location.href = '../student/student.html';
  }
}

async function handleLogout() {
  if (confirm('Are you sure you want to logout?')) {
    try {
      await fetch(API.LOGOUT, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${currentToken}`, 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      await chrome.storage.local.clear();
      window.location.href = '../auth/login.html';
    }
  }
}

function showError(message) {
  const errorMessage = document.getElementById('errorMessage');
  errorMessage.textContent = message;
  errorMessage.style.display = 'block';
}