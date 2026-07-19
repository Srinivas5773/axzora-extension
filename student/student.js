import { CONFIG, API } from "../config.js";

let currentToken = null;
let currentUser = null;
let currentStudent = null;
let currentJob = null;
let studentInfo = null;
let sponsorshipCache = null;
let isProcessing = false; // Global lock to prevent overlapping actions
let activeJobTabId = null; // Track the job tab for recording

// ==================== Retry-with-backoff fetch ====================
// Retries on network errors, timeouts, 5xx, and "busy" (429/503). Honors the
// server's Retry-After header. A per-attempt timeout keeps the UI from hanging
// forever when the backend is under load.
async function fetchWithRetry(url, options = {}, { attempts = 3, baseDelayMs = 500, label = 'request', timeoutMs = 30000 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      // 5xx (incl. 503 "busy") and 429 are retryable; everything else returns.
      const retryable = (resp.status >= 500 && resp.status < 600) || resp.status === 429;
      if (retryable && i < attempts - 1) {
        const ra = parseInt(resp.headers.get('Retry-After') || '', 10);
        const waitMs = Number.isFinite(ra) ? ra * 1000 : baseDelayMs * Math.pow(2, i);
        console.warn(`${label}: ${resp.status}, retry ${i + 1}/${attempts - 1} in ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return resp;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const reason = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message;
      console.warn(`${label}: ${reason}, retry ${i + 1}/${attempts - 1}`);
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
      }
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`${label}: exhausted ${attempts} attempts`);
}


// Tracks whether the recording gate is currently open — referenced by
// setAllButtonsDisabled so it doesn't re-enable recording-gated buttons
// when no recording is active.
let recordingGateActive = false;

// Disable/enable all action buttons during processing
function setAllButtonsDisabled(disabled) {
  const buttonIds = [
    'startApplicationBtn', 'studentDetailsBtn', 'downloadResumeBtn',
    'coverLetterBtn', 'appliedBtn', 'comeAtLastBtn', 'skipJobBtn'
  ];
  buttonIds.forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (disabled) {
      btn.disabled = true;
    } else {
      btn.disabled = btn.hasAttribute('data-needs-recording') && !recordingGateActive;
    }
  });
}
function showAcknowledgementModal() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('ackOverlay');
    const checkbox = document.getElementById('ackCheckbox');
    const startBtn = document.getElementById('ackStartBtn');

    checkbox.checked = false;
    startBtn.disabled = true;
    overlay.classList.remove('hidden');

    const newCheckbox = checkbox.cloneNode(true);
    checkbox.parentNode.replaceChild(newCheckbox, checkbox);

    const newBtn = startBtn.cloneNode(true);
    startBtn.parentNode.replaceChild(newBtn, startBtn);

    newCheckbox.addEventListener('change', () => {
      newBtn.disabled = !newCheckbox.checked;
    });

    newBtn.addEventListener('click', () => {
      if (!newCheckbox.checked) return;
      overlay.classList.add('hidden');
      resolve();
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await initialize();

  document.getElementById('ask-ai-btn').addEventListener('click', async () => {
    const question = document.getElementById('ai-question').value.trim();
    if (!question) {
      alert('Please enter a question');
      return;
    }

    const answerBox = document.getElementById('ai-answer');
    answerBox.value = 'Generating answer...';

    try {
      const res = await fetch(API.AI_ANSWER, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentToken}`
        },
        body: JSON.stringify({
          question,
          jobId: window.currentJobId,
          email: window.currentJobEmail
        })
      });

      if (res.status === 503 || res.status === 429) {
        answerBox.value = 'AI is busy right now. Please try again in a moment.';
        return;
      }
      if (res.status === 401) {
        answerBox.value = 'Session expired. Please log in again.';
        return;
      }

      const data = await res.json();
      answerBox.value = data.answer || 'No answer generated';
    } catch (err) {
      console.error(err);
      answerBox.value = 'Failed to generate answer';
    }
  });

  document.getElementById('copy-ai-answer').addEventListener('click', () => {
    const text = document.getElementById('ai-answer').value;
    navigator.clipboard.writeText(text);
  });
});

async function initialize() {
  await showAcknowledgementModal();

  const loadingState = document.getElementById('loadingState');
  const jobContent = document.getElementById('jobContent');
  const noJobsMessage = document.getElementById('noJobsMessage');

  try {
    const isAuthenticated = await checkAuth();

    if (!isAuthenticated) {
      window.location.href = '../auth/login.html';
      return;
    }

    const hasStudent = await loadCurrentStudent();

    if (!hasStudent) {
      window.location.href = '../popup/popup.html';
      return;
    }

    displayStudentHeader();
    await loadSponsorshipInfo();
    await loadNextJob();

    setupEventListeners();

  } catch (error) {
    console.error('Initialization error:', error);
    loadingState.style.display = 'none';
    showError('Failed to load job. Please try again.');
  }
}

async function checkAuth() {
  const result = await chrome.storage.local.get([CONFIG.TOKEN_KEY, CONFIG.USER_KEY]);

  if (!result[CONFIG.TOKEN_KEY] || !result[CONFIG.USER_KEY]) {
    return false;
  }

  const userData = result[CONFIG.USER_KEY];
  if (userData.expiresAt < Date.now()) {
    await chrome.storage.local.clear();
    return false;
  }

  currentToken = result[CONFIG.TOKEN_KEY];
  currentUser = userData;

  return true;
}

async function loadCurrentStudent() {
  const result = await chrome.storage.local.get([CONFIG.CURRENT_STUDENT_KEY]);
  
  if (!result[CONFIG.CURRENT_STUDENT_KEY]) {
    return false;
  }

  currentStudent = result[CONFIG.CURRENT_STUDENT_KEY];
  return true;
}

function displayStudentHeader() {
  document.getElementById('studentName').textContent = currentStudent.fullName;
  document.getElementById('studentEmail').textContent = currentStudent.email;
}

async function loadSponsorshipInfo() {
  try {
    const response = await fetch(`${API.STUDENT_INFO}?email=${encodeURIComponent(currentStudent.email)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('Failed to fetch sponsorship info');
      return;
    }

    const data = await response.json();
    
    if (!data.studentInfo || !data.studentInfo.personalData) return;

    let personalData = data.studentInfo.personalData;
    if (typeof personalData === 'string') {
      try { personalData = JSON.parse(personalData); } catch(e) { return; }
    }

    sponsorshipCache = {
      now: personalData.requireVisaSponsorshipNow || '—',
      future: personalData.requireVisaSponsorshipFuture || '—',
      fetchedAt: Date.now()
    };

    displaySponsorshipBanner();
    renderAccount(personalData);
    // No auto-refresh needed — sponsorship info doesn't change during a session

  } catch (error) {
    console.error('Error loading sponsorship info:', error);
  }
}

function renderAccount(personalData) {
  const container = document.getElementById('accountContent');
  if (!container) return;
  container.innerHTML = '';
  ['email', 'password'].forEach(key => {
    const value = Object.prototype.hasOwnProperty.call(personalData, key) ? personalData[key] : null;
    container.appendChild(createInfoField(key, value));
  });
}

function displaySponsorshipBanner() {
  if (!sponsorshipCache) return;

  const nowEl = document.getElementById('sponsorshipNow');
  const futureEl = document.getElementById('sponsorshipFuture');

  nowEl.textContent = sponsorshipCache.now;
  futureEl.textContent = sponsorshipCache.future;

  // Color coding: Yes = red (needs attention), No = green
  nowEl.className = 'sponsorship-value ' + 
    (sponsorshipCache.now.toLowerCase() === 'yes' ? 'val-yes' : 
     sponsorshipCache.now.toLowerCase() === 'no' ? 'val-no' : '');

  futureEl.className = 'sponsorship-value ' + 
    (sponsorshipCache.future.toLowerCase() === 'yes' ? 'val-yes' : 
     sponsorshipCache.future.toLowerCase() === 'no' ? 'val-no' : '');
}

async function loadNextJob() {
  const loadingState = document.getElementById('loadingState');
  const jobContent = document.getElementById('jobContent');
  const noJobsMessage = document.getElementById('noJobsMessage');

  try {
    loadingState.style.display = 'block';
    jobContent.style.display = 'none';
    noJobsMessage.style.display = 'none';

    console.log('Loading next job for email:', currentStudent.email);

    const response = await fetch(`${API.STUDENT_JOBS}?email=${encodeURIComponent(currentStudent.email)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        await chrome.storage.local.clear();
        window.location.href = '../auth/login.html';
        return;
      }
      throw new Error('Failed to fetch job');
    }

    const data = await response.json();
    console.log('Received job data from backend:', data);

    if (!data.job) {
      loadingState.style.display = 'none';
      await showNoJobsStatus();
      return;
    }

    currentJob = data.job;
    console.log('Set currentJob to:', currentJob);
    console.log('Resume path in new job:', currentJob.resumePath);
    
    displayJob(data.job);

    loadingState.style.display = 'none';
    jobContent.style.display = 'block';

  } catch (error) {
    console.error('Error loading job:', error);
    loadingState.style.display = 'none';
    showError('Failed to load job');
  }
}

async function showNoJobsStatus() {
  const noJobsMessage = document.getElementById('noJobsMessage');

  let completionStatus = 'unknown';
  let screenshotNeeded = false;

  try {
    const resp = await fetch(API.STUDENTS_SUMMARY, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    const data = await resp.json();
    if (data.success) {
      const entry = (data.students || []).find(s => s.email === currentStudent.email);
      if (entry) {
        completionStatus = entry.completionStatus || 'unknown';
        screenshotNeeded = entry.screenshotNeeded === true;
      }
    }
  } catch (e) {
    console.error('Error fetching no-jobs status:', e);
  }

  // Build message based on status
  let messageHTML = '';

  if (completionStatus === 'complete' && screenshotNeeded) {
    messageHTML = `
      <div style="text-align:center;padding:24px 20px;">
        <div style="font-size:32px;margin-bottom:12px;">✅</div>
        <div style="font-size:16px;font-weight:700;color:#1a7a3f;margin-bottom:8px;">Completed!</div>
        <div style="font-size:13px;color:#333;margin-bottom:20px;line-height:1.5;">
          All applications are done. Please submit your screenshots now.
        </div>
        <div style="background:#f0faf0;border:1.5px solid #27ae60;border-radius:8px;padding:14px 16px;margin-bottom:20px;" onclick="event.stopPropagation()">
          <label id="screenshotLabel" style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:#1a7a3f;font-weight:600;justify-content:center;">
            <input type="checkbox" id="noJobsScreenshotCheck" style="width:16px;height:16px;accent-color:#27ae60;cursor:pointer;" />
            Screenshots submitted for this student
          </label>
        </div>
        <button id="backToStudentsBtn" class="btn-secondary">Back to Students</button>
      </div>
    `;
  } else if (completionStatus === 'complete' && !screenshotNeeded) {
    messageHTML = `
      <div style="text-align:center;padding:24px 20px;">
        <div style="font-size:32px;margin-bottom:12px;">🎉</div>
        <div style="font-size:16px;font-weight:700;color:#1a7a3f;margin-bottom:8px;">Completed for today!</div>
        <div style="font-size:13px;color:#333;margin-bottom:20px;line-height:1.5;">
          All applications are done and screenshots are submitted.
        </div>
        <button id="backToStudentsBtn" class="btn-secondary">Back to Students</button>
      </div>
    `;
  } else if (completionStatus === 'incomplete') {
    messageHTML = `
      <div style="text-align:center;padding:24px 20px;">
        <div style="font-size:32px;margin-bottom:12px;">⏳</div>
        <div style="font-size:16px;font-weight:700;color:#b85c00;margin-bottom:8px;">More applications coming!</div>
        <div style="font-size:13px;color:#333;margin-bottom:20px;line-height:1.5;">
          Please wait — you have more applications to finish and they will load shortly.
        </div>
        <button id="backToStudentsBtn" class="btn-secondary">Back to Students</button>
      </div>
    `;
  } else {
    messageHTML = `
      <div style="text-align:center;padding:24px 20px;">
        <div style="font-size:32px;margin-bottom:12px;">🔴</div>
        <div style="font-size:16px;font-weight:700;color:#a00;margin-bottom:8px;">Status Unknown</div>
        <div style="font-size:13px;color:#333;margin-bottom:20px;line-height:1.5;">
          Please contact your supervisor.
        </div>
        <button id="backToStudentsBtn" class="btn-secondary">Back to Students</button>
      </div>
    `;
  }

  noJobsMessage.innerHTML = messageHTML;
  noJobsMessage.style.display = 'block';

  // Wire up back button
  document.getElementById('backToStudentsBtn')?.addEventListener('click', () => window.close());

  // Wire up screenshot checkbox if present
  const screenshotCheck = document.getElementById('noJobsScreenshotCheck');
  if (screenshotCheck) {
    screenshotCheck.addEventListener('change', async (e) => {
      if (screenshotCheck.checked) {
        screenshotCheck.checked = false; // reset until confirmed

        // Confirmation modal (reuse same pattern)
        const confirmed = await showNoJobsScreenshotModal();
        if (!confirmed) return;

        screenshotCheck.disabled = true;
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

        try {
          const resp = await fetch(API.SUBMIT_SCREENSHOT, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${currentToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email: currentStudent.email, date: today })
          });
          const data = await resp.json();
          if (data.success) {
            const box = document.getElementById('screenshotLabel')?.parentElement;
            if (box) {
              box.innerHTML = '<div style="font-size:13px;color:#1a7a3f;font-weight:700;">✓ Screenshots submitted!</div>';
            }
          } else {
            screenshotCheck.disabled = false;
          }
        } catch (err) {
          console.error('Screenshot submit error:', err);
          screenshotCheck.disabled = false;
        }
      }
    });
  }
}

function showNoJobsScreenshotModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:100%;max-width:360px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
        <div style="background:#000;color:#fff;padding:14px 20px;font-size:14px;font-weight:700;border-left:5px solid #27ae60;">
          📸 Confirm Screenshot Submission
        </div>
        <div style="padding:18px 20px;">
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px;color:#000;font-weight:600;">
            <input type="checkbox" id="noJobsSsConfirmCheck" style="width:15px;height:15px;flex-shrink:0;margin-top:2px;accent-color:#000;cursor:pointer;" />
            <span>I have submitted the screenshot PDF for this student in the group.</span>
          </label>
        </div>
        <div style="padding:0 20px 18px;display:flex;gap:10px;">
          <button id="noJobsSsCancel" style="flex:1;padding:10px;background:#fff;color:#000;border:2px solid #000;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;">Cancel</button>
          <button id="noJobsSsConfirm" style="flex:1;padding:10px;background:#ccc;color:#888;border:none;border-radius:7px;font-size:13px;font-weight:700;cursor:not-allowed;" disabled>Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const check = overlay.querySelector('#noJobsSsConfirmCheck');
    const confirmBtn = overlay.querySelector('#noJobsSsConfirm');
    const cancelBtn = overlay.querySelector('#noJobsSsCancel');

    check.addEventListener('change', () => {
      confirmBtn.disabled = !check.checked;
      confirmBtn.style.background = check.checked ? '#000' : '#ccc';
      confirmBtn.style.color = check.checked ? '#fff' : '#888';
      confirmBtn.style.cursor = check.checked ? 'pointer' : 'not-allowed';
    });

    cancelBtn.addEventListener('click', () => { document.body.removeChild(overlay); resolve(false); });
    confirmBtn.addEventListener('click', () => {
      if (!check.checked) return;
      document.body.removeChild(overlay);
      resolve(true);
    });
  });
}

function displayJob(job) {
  document.getElementById('jobNumber').textContent = `Job #${job.jobNumber || '1'}`;
  
  const jobLink = document.getElementById('jobLink');
  jobLink.href = job.jobLink;
  jobLink.textContent = job.jobLink;

  document.getElementById('jobDescription').textContent = job.jobDescription;
  
  // Update currentJob completely with new job data
  currentJob = {
    jobId: job.jobId,
    jobLink: job.jobLink,
    jobDescription: job.jobDescription,
    jobNumber: job.jobNumber,
    timestamp: job.timestamp,
    email: job.email,
    resumePath: job.resumePath || null,
    // Preserve the do-not-apply flag so the Start-click popup fires for flagged jobs.
    doNotApplyReview: !!job.doNotApplyReview,
    doNotApplyCompany: job.doNotApplyCompany || ''
  };

  // ✅ STORE DYNAMODB KEYS FOR AI / BACKEND CALLS
  window.currentJobId = job.jobId;
  window.currentJobEmail = job.email;

  // Each new job must be re-recorded — re-lock the action buttons.
  setRecordingGate(false);

  console.log('Current job updated:', currentJob);
}


// ==================== RECORDING GATE ====================
function setRecordingGate(isRecording, message) {
  recordingGateActive = !!isRecording;
  document.querySelectorAll('button[data-needs-recording]').forEach(btn => {
    btn.disabled = !isRecording;
    btn.title = isRecording ? '' : 'Start screen recording first';
  });

  // Hide content that was unlocked by a previous recording, so the student's
  // details aren't readable once recording stops.
  if (!isRecording) {
    const studentInfoSection = document.getElementById('studentInfoSection');
    if (studentInfoSection) {
      studentInfoSection.style.display = 'none';
      const studentInfoContent = document.getElementById('studentInfoContent');
      if (studentInfoContent) studentInfoContent.innerHTML = '';
    }
  }

  const status = document.getElementById('recordingStatus');
  const text = document.getElementById('recordingStatusText');
  if (!status || !text) return;
  status.classList.toggle('rec-on', !!isRecording);
  status.classList.toggle('rec-off', !isRecording);
  text.textContent = message || (isRecording
    ? 'Recording — all application actions are now active'
    : 'Not recording — click Start Application to begin');
}

// ==================== RECORDING STATE ====================
const RECORDING_MAX_MS = 45 * 60 * 1000;       // hard cap
const RECORDING_WARN_BEFORE_MS = 10 * 60 * 1000; // warn this far before the cap

let recordingState = {
  mediaRecorder: null,
  chunks: [],
  stream: null,
  jobId: null,
  studentEmail: null,
  autoStopTimer: null,
  warnTimer: null,
  startedAt: null
};

async function stopAndUploadRecording(jobId, studentEmail, action = 'applied', skipReason = '') {
  try {
    if (!recordingState.mediaRecorder ||
        recordingState.mediaRecorder.state === 'inactive' ||
        recordingState.jobId !== jobId) {
      console.log('No active recording for this job — logging failure');
      const failForm = new FormData();
      failForm.append('jobId', jobId);
      failForm.append('studentEmail', studentEmail);
      failForm.append('applierEmail', currentUser?.email || '');
      failForm.append('recorded', 'false');
      failForm.append('reason', 'not_recording');
      failForm.append('action', action);
      if (skipReason) failForm.append('skipReason', skipReason);
      await fetchWithRetry(API.UPLOAD_RECORDING, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${currentToken}` },
        body: failForm
      }, { attempts: 3, baseDelayMs: 800, label: 'upload-recording-fail-log' })
        .catch(e => console.error('Failed to log missing recording:', e));
      return;
    }

    if (recordingState.autoStopTimer) {
      clearTimeout(recordingState.autoStopTimer);
      recordingState.autoStopTimer = null;
    }
    if (recordingState.warnTimer) {
      clearTimeout(recordingState.warnTimer);
      recordingState.warnTimer = null;
    }

    // Stop and wait for all chunks
    await new Promise((resolve) => {
      recordingState.mediaRecorder.addEventListener('stop', resolve, { once: true });
      recordingState.mediaRecorder.stop();
    });

    // Cap the uploaded video to the LAST 15 minutes — keeps Render upload
    // size bounded (~33 MB max at 720p/300kbps) so workers aren't tied up for
    // 30-50s on long recordings. The applier still gets full-duration tracking
    // via durationMinutes; only the *video* is trimmed.
    const UPLOAD_CAP_MIN = 15;
    const CHUNKS_PER_MIN = 6; // chunks fire every 10s
    const MAX_CHUNKS = UPLOAD_CAP_MIN * CHUNKS_PER_MIN;
    const totalChunks = recordingState.chunks.length;
    const chunksToUpload = totalChunks > MAX_CHUNKS
      ? recordingState.chunks.slice(-MAX_CHUNKS)
      : recordingState.chunks;
    const trimmed = totalChunks > MAX_CHUNKS;

    const blob = new Blob(chunksToUpload, { type: 'video/webm' });
    const durationMinutes = recordingState.startedAt
      ? Math.round((Date.now() - recordingState.startedAt) / 60000)
      : 0;
    const uploadedDurationMinutes = Math.min(durationMinutes, UPLOAD_CAP_MIN);
    console.log(
      `Recording stopped — job: ${jobId}, size: ${blob.size}, action: ${action}, ` +
      `actualDuration: ${durationMinutes}m, uploadedDuration: ${uploadedDurationMinutes}m, trimmed: ${trimmed}`
    );

    // Free chunks from memory immediately — blob already holds the data
    recordingState.chunks = [];
    recordingState = { mediaRecorder: null, chunks: [], stream: null, jobId: null, studentEmail: null, autoStopTimer: null, warnTimer: null, startedAt: null };

    const formData = new FormData();
    formData.append('jobId', jobId);
    formData.append('studentEmail', studentEmail);
    formData.append('applierEmail', currentUser?.email || '');
    formData.append('recorded', 'true');
    formData.append('action', action);
    formData.append('durationMinutes', String(durationMinutes));            // actual session length
    formData.append('uploadedDurationMinutes', String(uploadedDurationMinutes)); // video length
    formData.append('trimmed', trimmed ? 'true' : 'false');
    if (skipReason) formData.append('skipReason', skipReason);
    formData.append('video', blob, `${jobId}.webm`);

    // Fire-and-forget: upload in the BACKGROUND so the applier can move to the
    // next job immediately instead of waiting on a multi-MB upload. Retries,
    // timeout, and "busy" (429/503) handling are done by fetchWithRetry.
    fetchWithRetry(API.UPLOAD_RECORDING, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${currentToken}` },
      // No Content-Type header — browser sets it automatically with boundary for FormData
      body: formData
    }, { attempts: 4, baseDelayMs: 1000, label: 'upload-recording', timeoutMs: 120000 })
      .then(async (uploadResp) => {
        const uploadData = await uploadResp.json().catch(() => ({}));
        if (uploadData.success) {
          console.log(`Recording uploaded — action: ${action}`);
        } else {
          console.error('Recording upload failed — status:', uploadResp.status, 'response:', JSON.stringify(uploadData));
        }
      })
      .catch(e => console.error('Background recording upload error:', e));
    // Return now — the applier is not blocked on the upload.

  } catch (e) {
    console.error('stopAndUploadRecording error:', e);
  }
}

// Blocking modal shown on Start for jobs flagged as a possible do-not-apply company.
// Resolves true (continue) or false (don't start — applier will Skip).
function showDoNotApplyPopup(company, list) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;';
    const listHtml = (list && list.length)
      ? list.map(c => `<span style="display:inline-block;background:#fee2e2;color:#991b1b;border-radius:9999px;padding:2px 8px;margin:2px;font-size:12px;">${c}</span>`).join('')
      : '<span style="color:#6b7280;">none listed — check with the student</span>';
    overlay.innerHTML = `
      <div style="background:#fff;max-width:440px;width:90%;border-radius:12px;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,0.3);font-family:sans-serif;">
        <div style="font-size:16px;font-weight:700;color:#b91c1c;margin-bottom:8px;">⚠️ Double-check before you apply</div>
        <div style="font-size:14px;color:#374151;line-height:1.5;">This company${company ? ` (<b>${company}</b>)` : ''} may be in the student's <b>do-not-apply</b> list. Double-check the student details before you apply.</div>
        <div style="margin:12px 0;font-size:13px;color:#374151;"><b>Do-not-apply list:</b><br/>${listHtml}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button id="dnaSkipBtn" style="padding:8px 14px;border:1px solid #d1d5db;background:#fff;border-radius:8px;cursor:pointer;font-size:14px;">Skip this job</button>
          <button id="dnaOkBtn" style="padding:8px 14px;border:none;background:#b91c1c;color:#fff;border-radius:8px;cursor:pointer;font-size:14px;">OK — continue</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#dnaOkBtn').addEventListener('click', () => { overlay.remove(); resolve(true); });
    overlay.querySelector('#dnaSkipBtn').addEventListener('click', () => { overlay.remove(); resolve(false); });
  });
}

async function handleStartApplication() {
  const startBtn = document.getElementById('startApplicationBtn');

  if (isProcessing) return;
  if (!currentJob || !currentJob.jobId) {
    showError('No job loaded');
    return;
  }

  // Do-not-apply double-check — only for flagged jobs. Must acknowledge before recording starts.
  if (currentJob.doNotApplyReview) {
    const proceed = await showDoNotApplyPopup(currentJob.doNotApplyCompany, (studentInfo && studentInfo.doNotApplyCompanies) || []);
    if (!proceed) return;
  }

  const captureJobId = currentJob.jobId;
  const captureEmail = currentJob.email;
  const jobLink = currentJob.jobLink;

  try {
    startBtn.disabled = true;
    startBtn.textContent = 'Select screen to record...';

    // Stop any existing recording before starting a new one
    if (recordingState.mediaRecorder && recordingState.mediaRecorder.state !== 'inactive') {
      try { recordingState.mediaRecorder.stop(); } catch (e) { /* ignore */ }
    }
    if (recordingState.stream) {
      recordingState.stream.getTracks().forEach(t => t.stop());
    }
    if (recordingState.autoStopTimer) {
      clearTimeout(recordingState.autoStopTimer);
    }
    if (recordingState.warnTimer) {
      clearTimeout(recordingState.warnTimer);
    }
    recordingState = { mediaRecorder: null, chunks: [], stream: null, jobId: null, studentEmail: null, autoStopTimer: null, warnTimer: null, startedAt: null };

    // Step 1: Prompt screen picker FIRST — block until user selects or cancels
    const streamId = await new Promise((resolve) => {
      chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], (id) => {
        resolve(id || null);
      });
    });

    if (!streamId) {
      showError('Screen recording is required to start the application');
      startBtn.textContent = 'Start Application';
      startBtn.disabled = false;
      return;
    }

    // Step 2: Get the media stream
    startBtn.textContent = 'Starting recording...';

    // Pick best available codec: prefer VP9 for better compression, fall back to VP8
    const preferVP9 = MediaRecorder.isTypeSupported('video/webm;codecs=vp9');
    const mimeType = preferVP9 ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: streamId,
            maxWidth: 1280,
            maxHeight: 720,
            maxFrameRate: 5
          }
        }
      });
    } catch (err) {
      console.error('getUserMedia failed:', err.name, err.message);
      showError('Failed to start screen recording. Please try again.');
      startBtn.textContent = 'Start Application';
      startBtn.disabled = false;
      return;
    }

    // Step 3: Start the MediaRecorder
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 300000
    });

    recordingState.chunks = [];
    recordingState.jobId = captureJobId;
    recordingState.studentEmail = captureEmail;
    recordingState.mediaRecorder = mediaRecorder;
    recordingState.stream = stream;
    recordingState.startedAt = Date.now();

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordingState.chunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      recordingState.stream = null;
      // If the recording ended without an Applied/Skip click (e.g. user hit
      // Chrome's "Stop sharing"), re-lock the buttons so they must restart.
      setRecordingGate(false, 'Recording stopped — click Start Application to record again');
    };

    stream.getVideoTracks()[0].onended = () => {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    };

    recordingState.warnTimer = setTimeout(() => {
      if (mediaRecorder.state !== 'inactive') {
        const minutesLeft = Math.round(RECORDING_WARN_BEFORE_MS / 60000);
        setRecordingGate(
          true,
          `Recording — auto-stops in ${minutesLeft} min. Click Applied/Skip soon.`
        );
      }
    }, RECORDING_MAX_MS - RECORDING_WARN_BEFORE_MS);

    recordingState.autoStopTimer = setTimeout(() => {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    }, RECORDING_MAX_MS);

    mediaRecorder.start(10000);
    setRecordingGate(true);
    console.log('Recording started — job:', captureJobId, '— codec:', mimeType);

    // Step 4: Recording is active — NOW open the job tab
    const tabResponse = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({
          action: 'openJobInNewTab',
          url: jobLink
        }, (resp) => {
          if (chrome.runtime.lastError) {
            console.log('sendMessage error (non-critical):', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(resp);
        });
      } catch(e) {
        resolve(null);
      }
    });

    if (tabResponse && tabResponse.tabId) {
      activeJobTabId = tabResponse.tabId;
    } else {
      try {
        const tabs = await chrome.tabs.query({ url: jobLink });
        if (tabs.length > 0) activeJobTabId = tabs[tabs.length - 1].id;
      } catch(e) {
        console.log('Could not find tab by URL:', e);
      }
    }

    startBtn.textContent = 'Recording & Opened';
    setTimeout(() => {
      startBtn.textContent = 'Start Application';
      startBtn.disabled = false;
    }, 2000);

  } catch (error) {
    console.error('Error starting application:', error);
    showError('Failed to start application');
    startBtn.disabled = false;
    startBtn.textContent = 'Start Application';
  }
}

async function handleStudentDetails() {
  const detailsBtn = document.getElementById('studentDetailsBtn');
  const studentInfoSection = document.getElementById('studentInfoSection');

  try {
    detailsBtn.disabled = true;
    detailsBtn.textContent = 'Loading...';

    // Load and display student information
    await loadStudentInfo();
    displayStudentInfo();

    detailsBtn.textContent = 'Student Details Loaded';
    studentInfoSection.style.display = 'block';

    // Scroll to student info
    studentInfoSection.scrollIntoView({ behavior: 'smooth' });

    setTimeout(() => {
      detailsBtn.textContent = 'Refresh Details';
      detailsBtn.disabled = false;
    }, 2000);

  } catch (error) {
    console.error('Error loading student details:', error);
    showError('Failed to load student information');
    detailsBtn.disabled = false;
    detailsBtn.textContent = 'Student Details';
  }
}

async function handleDownloadResume() {
  const resumeBtn = document.getElementById('downloadResumeBtn');

  if (isProcessing) return;
  if (!currentJob || !currentJob.jobId) {
    showError('No job loaded');
    return;
  }

  const jobIdAtStart = currentJob.jobId;

  try {
    isProcessing = true;
    setAllButtonsDisabled(true);
    resumeBtn.textContent = 'Fetching Resume...';

    const response = await fetch(
      `${API.JOB_RESUME}?email=${encodeURIComponent(currentJob.email)}&job_id=${encodeURIComponent(currentJob.jobId)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${currentToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Job changed while we were waiting — abort
    if (!currentJob || currentJob.jobId !== jobIdAtStart) {
      console.log('Job changed during resume download, aborting');
      return;
    }

    const data = await response.json();

    if (!response.ok || !data.success) {
      showError(data.message || 'Failed to generate download link');
      return;
    }

    // Open the presigned S3 URL in a new tab to download
    chrome.runtime.sendMessage({
      action: 'openJobInNewTab',
      url: data.resumeUrl
    });

    resumeBtn.textContent = 'Resume Downloaded';
    setTimeout(() => {
      resumeBtn.textContent = 'Download Resume';
    }, 3000);

  } catch (error) {
    console.error('Error downloading resume:', error);
    showError('Failed to download resume');
  } finally {
    isProcessing = false;
    setAllButtonsDisabled(false);
  }
}

async function handleCoverLetter() {
  const coverLetterBtn = document.getElementById('coverLetterBtn');

  if (isProcessing) return;
  if (!currentJob || !currentJob.jobId) {
    showError('No job loaded');
    return;
  }

  const jobIdAtStart = currentJob.jobId;

  try {
    isProcessing = true;
    setAllButtonsDisabled(true);
    coverLetterBtn.textContent = '⏳ Generating...';

    const response = await fetch(API.GENERATE_COVER_LETTER, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: currentJob.email,
        job_id: currentJob.jobId
      })
    });

    if (!currentJob || currentJob.jobId !== jobIdAtStart) {
      console.log('Job changed during cover letter generation, aborting');
      return;
    }

    if (response.status === 401) {
      showError('Session expired. Please log in again.');
      return;
    }

    const data = await response.json();

    if (!data.success) {
      showError(data.message || 'Failed to generate cover letter');
      return;
    }

    // Open the presigned URL in a new tab to download
    chrome.runtime.sendMessage({
      action: 'openJobInNewTab',
      url: data.coverLetterUrl
    });

    const label = data.cached ? 'Cover Letter (Cached)' : 'Cover Letter Ready';
    coverLetterBtn.textContent = `✓ ${label}`;
    setTimeout(() => {
      coverLetterBtn.textContent = 'Cover Letter';
    }, 3000);

  } catch (error) {
    console.error('Error generating cover letter:', error);
    showError('Failed to generate cover letter');
  } finally {
    isProcessing = false;
    setAllButtonsDisabled(false);
  }
}
function showAutofillQuestionModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:100%;max-width:420px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
        <div style="background:#000;color:#fff;padding:14px 20px;font-size:15px;font-weight:700;border-left:5px solid #c0392b;">
          Did you use autofill?
        </div>
        <div style="padding:20px;">
          <p style="font-size:13px;color:#444;margin:0 0 6px;line-height:1.5;">
            Autofill includes resume autofill or pre-fill, etc.
          </p>
        </div>
        <div style="padding:0 20px 20px;display:flex;gap:10px;">
          <button id="autofillCancelBtn" style="flex:1;padding:11px;background:#fff;color:#000;border:2px solid #000;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;">Cancel</button>
          <button id="autofillNoBtn" style="flex:1;padding:11px;background:#1f7a3a;color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;">No</button>
          <button id="autofillYesBtn" style="flex:1;padding:11px;background:#c0392b;color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;">Yes</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const finish = (value) => {
      document.body.removeChild(overlay);
      resolve(value);
    };

    overlay.querySelector('#autofillCancelBtn').addEventListener('click', () => finish(null));
    overlay.querySelector('#autofillNoBtn').addEventListener('click', () => finish('no'));
    overlay.querySelector('#autofillYesBtn').addEventListener('click', () => finish('yes'));
  });
}

function showAutofillRecheckModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:100%;max-width:420px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
        <div style="background:#000;color:#fff;padding:14px 20px;font-size:15px;font-weight:700;border-left:5px solid #c0392b;">
          ⚠️ Recheck the entire application
        </div>
        <div style="padding:20px;">
          <p style="font-size:13px;color:#444;margin:0 0 14px;line-height:1.5;">
            Autofilled applications usually contain <b>3-4 mistakes</b>. Open the application and verify every field against the student's details before continuing.
          </p>
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
            <input type="checkbox" id="recheckCheckbox" style="width:16px;height:16px;flex-shrink:0;margin-top:2px;accent-color:#000;" />
            <span style="font-size:13px;color:#000;line-height:1.5;">I rechecked every field and everything is correct.</span>
          </label>
        </div>
        <div style="padding:0 20px 20px;display:flex;gap:10px;">
          <button id="recheckCancelBtn" style="flex:1;padding:11px;background:#fff;color:#000;border:2px solid #000;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;">Cancel</button>
          <button id="recheckContinueBtn" style="flex:1;padding:11px;background:#ccc;color:#888;border:none;border-radius:7px;font-size:13px;font-weight:700;cursor:not-allowed;" disabled>Continue</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const checkbox = overlay.querySelector('#recheckCheckbox');
    const continueBtn = overlay.querySelector('#recheckContinueBtn');
    const cancelBtn = overlay.querySelector('#recheckCancelBtn');

    checkbox.addEventListener('change', () => {
      const checked = checkbox.checked;
      continueBtn.disabled = !checked;
      continueBtn.style.background = checked ? '#000' : '#ccc';
      continueBtn.style.color = checked ? '#fff' : '#888';
      continueBtn.style.cursor = checked ? 'pointer' : 'not-allowed';
    });

    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve(false);
    });

    continueBtn.addEventListener('click', () => {
      if (!checkbox.checked) return;
      document.body.removeChild(overlay);
      resolve(true);
    });
  });
}

function showAppliedConfirmModal() {
  return new Promise((resolve) => {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:100%;max-width:420px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);max-height:90vh;display:flex;flex-direction:column;">
        <div style="background:#000;color:#fff;padding:14px 20px;font-size:15px;font-weight:700;border-left:5px solid #c0392b;">
          ✅ Confirm Application Submitted
        </div>
        <div style="padding:20px;overflow-y:auto;">
          <div style="background:#fff4f4;border:1px solid #f3c0c0;color:#a33;padding:9px 12px;border-radius:6px;font-size:12px;font-weight:600;margin-bottom:16px;line-height:1.45;">
            This will be reviewed later. Mistakes may lead to termination. Each application decides a student's future — it is important to fill correct information.
          </div>

          <p style="font-size:13px;color:#444;margin-bottom:16px;">You must confirm both before marking this job as applied.</p>

          <label style="display:flex;align-items:flex-start;gap:10px;margin-bottom:14px;cursor:pointer;">
            <input type="checkbox" id="confirmCheck1" style="width:16px;height:16px;flex-shrink:0;margin-top:2px;accent-color:#000;" />
            <span style="font-size:13px;color:#000;line-height:1.5;">I acknowledge that I double-checked every single field before submitting this application and answered according to the student's details.</span>
          </label>

          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
            <input type="checkbox" id="confirmCheck2" style="width:16px;height:16px;flex-shrink:0;margin-top:2px;accent-color:#000;" />
            <span style="font-size:13px;color:#000;line-height:1.5;">I applied for this job.</span>
          </label>
        </div>
        <div style="padding:0 20px 20px;display:flex;gap:10px;">
          <button id="confirmCancelBtn" style="flex:1;padding:11px;background:#fff;color:#000;border:2px solid #000;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;">Cancel</button>
          <button id="confirmSubmitBtn" style="flex:1;padding:11px;background:#ccc;color:#888;border:none;border-radius:7px;font-size:13px;font-weight:700;cursor:not-allowed;" disabled>Confirm</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const check1 = overlay.querySelector('#confirmCheck1');
    const check2 = overlay.querySelector('#confirmCheck2');
    const submitBtn = overlay.querySelector('#confirmSubmitBtn');
    const cancelBtn = overlay.querySelector('#confirmCancelBtn');

    function updateBtn() {
      const both = check1.checked && check2.checked;
      submitBtn.disabled = !both;
      submitBtn.style.background = both ? '#000' : '#ccc';
      submitBtn.style.color = both ? '#fff' : '#888';
      submitBtn.style.cursor = both ? 'pointer' : 'not-allowed';
    }

    check1.addEventListener('change', updateBtn);
    check2.addEventListener('change', updateBtn);

    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve(false);
    });

    submitBtn.addEventListener('click', () => {
      if (!check1.checked || !check2.checked) return;
      document.body.removeChild(overlay);
      resolve(true);
    });
  });
}

async function handleApplied() {
  const appliedBtn = document.getElementById('appliedBtn');

  if (isProcessing) return;
  if (!currentJob || !currentJob.jobId) {
    showError('No job loaded');
    return;
  }

  isProcessing = true;
  setAllButtonsDisabled(true);

  // Step 1 — Did you use autofill?
  const autofillAnswer = await showAutofillQuestionModal();
  if (autofillAnswer === null) {
    isProcessing = false;
    setAllButtonsDisabled(false);
    return;
  }

  // Step 2 — If yes, force a recheck confirmation
  if (autofillAnswer === 'yes') {
    const rechecked = await showAutofillRecheckModal();
    if (!rechecked) {
      isProcessing = false;
      setAllButtonsDisabled(false);
      return;
    }
  }

  // Step 3 — Existing confirm modal (now with review-warning banner)
  const confirmed = await showAppliedConfirmModal();
  if (!confirmed) {
    isProcessing = false;
    setAllButtonsDisabled(false);
    return;
  }

  // Stop recording silently after confirmation — don't await, runs in background
  stopAndUploadRecording(currentJob.jobId, currentJob.email, 'applied');

  const jobIdAtStart = currentJob.jobId;
  const emailAtStart = currentJob.email;

  try {
    appliedBtn.textContent = 'Processing...';

    // Clear currentJob during transition to block any other actions
    currentJob = null;

    const response = await fetch(
    `${API.MARK_JOB_APPLIED}?job_id=${encodeURIComponent(jobIdAtStart)}&email=${encodeURIComponent(emailAtStart)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

    const data = await response.json();

    if (!response.ok || !data.success) {
      showError(data.message || 'Failed to mark job as applied');
      // Restore currentJob on failure
      currentJob = { jobId: jobIdAtStart, email: emailAtStart };
      return;
    }

    const successMsg = document.createElement('div');
    successMsg.className = 'success-banner';
    successMsg.textContent = '✓ Job marked as applied! Loading next job...';
    successMsg.style.cssText =
      'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #4CAF50; color: white; padding: 16px 24px; border-radius: 8px; font-weight: 600; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
    document.body.appendChild(successMsg);

    setTimeout(() => {
      successMsg.remove();

      const studentInfoSection = document.getElementById('studentInfoSection');
      if (studentInfoSection) studentInfoSection.style.display = 'none';

      // Use the next job returned directly from the backend (avoids stale read bug)
      if (data.nextJob) {
        displayJob(data.nextJob);
        document.getElementById('loadingState').style.display = 'none';
        document.getElementById('jobContent').style.display = 'block';
        document.getElementById('noJobsMessage').style.display = 'none';
      } else {
        // No more jobs
        document.getElementById('jobContent').style.display = 'none';
        document.getElementById('noJobsMessage').style.display = 'block';
      }

      appliedBtn.textContent = 'Applied';
    }, 1500);

  } catch (error) {
    console.error('Error marking job as applied:', error);
    showError('Failed to mark job as applied');
    // Restore currentJob on failure
    if (!currentJob) currentJob = { jobId: jobIdAtStart, email: emailAtStart };
  } finally {
    isProcessing = false;
    setAllButtonsDisabled(false);
  }
}


async function loadStudentInfo() {
  const response = await fetch(`${API.STUDENT_INFO}?email=${encodeURIComponent(currentStudent.email)}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${currentToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error('Failed to fetch student info');
  }

  const data = await response.json();
  studentInfo = data.studentInfo;
}

function displayStudentInfo() {
  const container = document.getElementById('studentInfoContent');
  container.innerHTML = '';

  console.log('studentInfo:', studentInfo);
  
  if (!studentInfo) {
    container.innerHTML = '<p style="text-align: center; color: #666;">No student information available</p>';
    return;
  }

  console.log('studentInfo.personalData:', studentInfo.personalData);

  if (!studentInfo.personalData) {
    container.innerHTML = '<p style="text-align: center; color: #666;">Student data is empty. Check backend response.</p>';
    return;
  }

  let personalData;
  try {
    personalData = typeof studentInfo.personalData === 'string' 
      ? JSON.parse(studentInfo.personalData) 
      : studentInfo.personalData;
  } catch (e) {
    console.error('Error parsing personalData:', e);
    container.innerHTML = '<p style="text-align: center; color: #666;">Error parsing student data</p>';
    return;
  }

  console.log('Parsed personalData:', personalData);

  // Always-visible do-not-apply panel so the applier can cross-check every job.
  {
    const dnaList = studentInfo.doNotApplyCompanies || [];
    const dnaNa = !!studentInfo.doNotApplyNa;
    let body;
    if (dnaList.length > 0) {
      body = dnaList.map(c => `<span style="display:inline-block;background:#fee2e2;color:#991b1b;border-radius:9999px;padding:2px 8px;margin:2px;font-size:12px;">${c}</span>`).join('');
    } else if (dnaNa) {
      body = '<span style="color:#6b7280;">N/A — student confirmed no companies to avoid</span>';
    } else {
      body = '<span style="color:#92400e;">Not set — please ask the student if they have any companies to avoid.</span>';
    }
    container.insertAdjacentHTML('afterbegin',
      `<div style="border:1px solid #fecaca;background:#fff7f7;border-radius:8px;padding:10px 12px;margin-bottom:12px;">
         <div style="font-weight:600;color:#991b1b;margin-bottom:6px;">🚫 Do Not Apply Companies</div>${body}
       </div>`);
  }

  // Define field groups for better organization
  const fieldGroups = {
    '👤 Personal Information': [
      'firstName', 'middleName', 'lastName', 'fullName', 'prefix', 'suffix', 
      'dateOfBirth', 'emailAddress', 'phone', 'gender', 'linkedin'
    ],
    '📍 Address': [
      'currentLocation', 'addressLine1', 'addressLine2', 'city', 'state', 
      'county', 'postalCode', 'country', 'countryCode'
    ],
    '💼 Work Authorization': [
      'workAuthorization', 'authorizedToWork', 'visaStatus', 
      'requireVisaSponsorshipNow', 'requireVisaSponsorshipFuture'
    ],
    '⚙️ Work Preferences': [
      'preferredWorkArrangement', 'targetCompensation', 'openToRelocation', 
      'currentCompany', 'companiesWorked'
    ],
    '📜 Certifications': [
      'certifications'
    ],
    'ℹ️ Demographics (Optional)': [
      'atLeast18', 'identifyAsTransgender', 'raceEthnicBackground', 
      'veteranStatus', 'disabilityStatus', 'languages'
    ],
    '🎯 Targeting': [
      'targetedJobs'
    ]
  };

  // Helper to create a collapsible section (collapsed by default)
  function createCollapsibleGroup(title, buildContent) {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'collapsible-group';

    const header = document.createElement('h3');
    header.className = 'collapsible-header';
    header.innerHTML = `<span class="collapsible-arrow">&#9654;</span> ${title}`;

    const body = document.createElement('div');
    body.className = 'collapsible-body';

    buildContent(body);

    header.addEventListener('click', () => {
      const isOpen = body.classList.toggle('open');
      header.classList.toggle('expanded', isOpen);
    });

    groupDiv.appendChild(header);
    groupDiv.appendChild(body);
    return groupDiv;
  }

  // Create fields by group
  Object.entries(fieldGroups).forEach(([groupName, fields]) => {
    const groupDiv = createCollapsibleGroup(groupName, (body) => {
      fields.forEach(key => {
        const value = Object.prototype.hasOwnProperty.call(personalData, key) ? personalData[key] : null;
        const fieldDiv = createInfoField(key, value);
        body.appendChild(fieldDiv);
      });
    });
    container.appendChild(groupDiv);
  });

  // Handle references separately
  if (personalData.references && personalData.references.length > 0) {
    const groupDiv = createCollapsibleGroup('👥 References', (body) => {
      personalData.references.forEach((ref, idx) => {
        const refDiv = createReferenceField(ref, idx + 1);
        body.appendChild(refDiv);
      });
    });
    container.appendChild(groupDiv);
  }

  // Handle experience details separately
  if (personalData.experienceDetails && personalData.experienceDetails.length > 0) {
    const groupDiv = createCollapsibleGroup('🏢 Experience Details', (body) => {
      personalData.experienceDetails.forEach((exp, idx) => {
        const expDiv = createExperienceField(exp, idx + 1);
        body.appendChild(expDiv);
      });
    });
    container.appendChild(groupDiv);
  }

  // Handle education details
  if (personalData.education && personalData.education.length > 0) {
    const groupDiv = createCollapsibleGroup('🎓 Education', (body) => {
      personalData.education.forEach((edu, idx) => {
        const eduDiv = createEducationField(edu, idx + 1);
        body.appendChild(eduDiv);
      });
    });
    container.appendChild(groupDiv);
  }
}

function createInfoField(key, value) {
  const fieldDiv = document.createElement('div');
  fieldDiv.className = 'info-field';

  const headerDiv = document.createElement('div');
  headerDiv.className = 'info-field-header';

  const label = document.createElement('div');
  label.className = 'info-label';
  label.textContent = formatLabel(key);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-copy-small';
  copyBtn.textContent = 'Copy';
  const rendered = formatValue(value, key);
  copyBtn.onclick = () => copyToClipboard(rendered || '', copyBtn);

  headerDiv.appendChild(label);

  // Target Compensation gets an AI "Get" button that suggests a realistic
  // target for the current job/role (display-only; does not save to profile).
  if (key === 'targetCompensation') {
    const getBtn = document.createElement('button');
    getBtn.className = 'btn-copy-small';
    getBtn.textContent = 'Get';
    getBtn.style.marginRight = '6px';
    headerDiv.appendChild(getBtn);
    headerDiv.appendChild(copyBtn);

    const valueDiv = document.createElement('div');
    valueDiv.className = 'info-value';
    valueDiv.textContent = rendered || 'N/A';

    // AI suggestion area (hidden until "Get" is clicked)
    const suggestionWrap = document.createElement('div');
    suggestionWrap.style.cssText = 'display:none;margin-top:8px;padding:8px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;';

    const suggestionText = document.createElement('div');
    suggestionText.style.cssText = 'white-space:pre-wrap;font-size:13px;line-height:1.4;color:#24292f;';

    const suggestionCopy = document.createElement('button');
    suggestionCopy.className = 'btn-copy-small';
    suggestionCopy.textContent = 'Copy';
    suggestionCopy.style.cssText = 'margin-top:6px;display:none;';
    suggestionCopy.onclick = () => copyToClipboard(suggestionText.textContent || '', suggestionCopy);

    suggestionWrap.appendChild(suggestionText);
    suggestionWrap.appendChild(suggestionCopy);

    getBtn.onclick = async () => {
      if (!window.currentJobId || !window.currentJobEmail) {
        alert('Select a job first to estimate compensation for that role.');
        return;
      }
      getBtn.disabled = true;
      const originalLabel = getBtn.textContent;
      getBtn.textContent = '...';
      suggestionWrap.style.display = 'block';
      suggestionText.textContent = 'Estimating a realistic target for this role…';
      suggestionCopy.style.display = 'none';
      try {
        const res = await fetch(API.TARGET_COMPENSATION, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${currentToken}`
          },
          body: JSON.stringify({
            jobId: window.currentJobId,
            email: window.currentJobEmail
          })
        });
        if (res.status === 503 || res.status === 429) {
          suggestionText.textContent = 'AI is busy right now. Please try again in a moment.';
          return;
        }
        if (res.status === 401) {
          suggestionText.textContent = 'Session expired. Please log in again.';
          return;
        }
        const data = await res.json();
        suggestionText.textContent = data.suggestion || 'No suggestion generated.';
        suggestionCopy.style.display = data.suggestion ? 'inline-block' : 'none';
      } catch (err) {
        console.error(err);
        suggestionText.textContent = 'Failed to estimate compensation.';
      } finally {
        getBtn.disabled = false;
        getBtn.textContent = originalLabel;
      }
    };

    fieldDiv.appendChild(headerDiv);
    fieldDiv.appendChild(valueDiv);
    fieldDiv.appendChild(suggestionWrap);
    return fieldDiv;
  }

  headerDiv.appendChild(copyBtn);

  const valueDiv = document.createElement('div');
  valueDiv.className = 'info-value';
  valueDiv.textContent = rendered || 'N/A';

  fieldDiv.appendChild(headerDiv);
  fieldDiv.appendChild(valueDiv);

  return fieldDiv;
}

function createReferenceField(ref, num) {
  const refDiv = document.createElement('div');
  refDiv.className = 'info-field';
  refDiv.style.marginBottom = '12px';

  const headerDiv = document.createElement('div');
  headerDiv.className = 'info-field-header';

  const label = document.createElement('div');
  label.className = 'info-label';
  label.textContent = `Reference ${num}`;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-copy-small';
  copyBtn.textContent = 'Copy All';
  const refText = `Name: ${formatValue(ref.fullName, 'fullName')}\nEmail: ${formatValue(ref.email, 'email')}\nPhone: ${formatValue(ref.phone, 'phone')}\nRelation: ${formatValue(ref.relation, 'relation')}\nPosition: ${formatValue(ref.position, 'position')}`;
  copyBtn.onclick = () => copyToClipboard(refText, copyBtn);

  headerDiv.appendChild(label);
  headerDiv.appendChild(copyBtn);

  const valueDiv = document.createElement('div');
  valueDiv.className = 'info-value';
  
  // Create individual fields with copy buttons
  const fields = [
    { label: 'Name', value: ref.fullName },
    { label: 'Email', value: ref.email },
    { label: 'Phone', value: ref.phone },
    { label: 'Relation', value: ref.relation },
    { label: 'Position', value: ref.position }
  ];

  fields.forEach(field => {
    const fieldRow = document.createElement('div');
    fieldRow.style.display = 'flex';
    fieldRow.style.justifyContent = 'space-between';
    fieldRow.style.alignItems = 'center';
    fieldRow.style.marginBottom = '6px';
    fieldRow.style.padding = '4px 0';
    
    const fieldText = document.createElement('span');
    fieldText.innerHTML = `<strong>${field.label}:</strong> ${formatValue(field.value, field.label) || 'N/A'}`;
    
    const fieldCopyBtn = document.createElement('button');
    fieldCopyBtn.className = 'btn-copy-tiny';
    fieldCopyBtn.textContent = 'Copy';
    fieldCopyBtn.onclick = () => copyToClipboard(formatValue(field.value, field.label) || '', fieldCopyBtn);
    
    fieldRow.appendChild(fieldText);
    fieldRow.appendChild(fieldCopyBtn);
    valueDiv.appendChild(fieldRow);
  });

  refDiv.appendChild(headerDiv);
  refDiv.appendChild(valueDiv);

  return refDiv;
}

function createExperienceField(exp, num) {
  const expDiv = document.createElement('div');
  expDiv.className = 'info-field';
  expDiv.style.marginBottom = '12px';

  const headerDiv = document.createElement('div');
  headerDiv.className = 'info-field-header';

  const label = document.createElement('div');
  label.className = 'info-label';
  label.textContent = `Experience ${num}`;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-copy-small';
  copyBtn.textContent = 'Copy All';
  const expText = `Company: ${formatValue(exp.company, 'company')}\nRole: ${formatValue(exp.role, 'role')}\nStart Date: ${formatValue(exp.startDate, 'startDate')}\nEnd Date: ${formatValue(exp.endDate, 'endDate')}\n\nAddress: ${formatValue(exp.companyAddressLine1, 'companyAddressLine1')}, ${formatValue(exp.companyAddressLine2, 'companyAddressLine2')}\nCity: ${formatValue(exp.city, 'city')}, ${formatValue(exp.state, 'state')} ${formatValue(exp.postalCode, 'postalCode')}\nSupervisor: ${formatValue(exp.supervisorName, 'supervisorName')} (${formatValue(exp.supervisorRole, 'supervisorRole')})\nContact: ${formatValue(exp.supervisorContact, 'supervisorContact')}\nEmail: ${formatValue(exp.supervisorEmail, 'supervisorEmail')}\nCan Contact Company: ${formatValue(exp.canContactCompany, 'canContactCompany')}`;
  copyBtn.onclick = () => copyToClipboard(expText, copyBtn);

  headerDiv.appendChild(label);
  headerDiv.appendChild(copyBtn);

  const valueDiv = document.createElement('div');
  valueDiv.className = 'info-value';

  // Create individual fields with copy buttons
  const fields = [
    { label: 'Company', value: exp.company },
    { label: 'Role', value: exp.role },
    { label: 'Start Date', value: exp.startDate },
    { label: 'End Date', value: exp.endDate },
    { label: 'Address Line 1', value: exp.companyAddressLine1 },
    { label: 'Address Line 2', value: exp.companyAddressLine2 },
    { label: 'City', value: exp.city },
    { label: 'State', value: exp.state },
    { label: 'Postal Code', value: exp.postalCode },
    { label: 'County', value: exp.county },
    { label: 'Supervisor Name', value: exp.supervisorName },
    { label: 'Supervisor Role', value: exp.supervisorRole },
    { label: 'Supervisor Contact', value: exp.supervisorContact },
    { label: 'Supervisor Email', value: exp.supervisorEmail },
    { label: 'Can Contact Company', value: exp.canContactCompany }
  ];

  fields.forEach(field => {
    // Show all fields; if empty, display N/A
    
    const fieldRow = document.createElement('div');
    fieldRow.style.display = 'flex';
    fieldRow.style.justifyContent = 'space-between';
    fieldRow.style.alignItems = 'center';
    fieldRow.style.marginBottom = '6px';
    fieldRow.style.padding = '4px 0';
    
    const fieldText = document.createElement('span');
    const rendered = formatValue(field.value, field.label);
    fieldText.innerHTML = `<strong>${field.label}:</strong> ${rendered || 'N/A'}`;
    
    const fieldCopyBtn = document.createElement('button');
    fieldCopyBtn.className = 'btn-copy-tiny';
    fieldCopyBtn.textContent = 'Copy';
    fieldCopyBtn.onclick = () => copyToClipboard(rendered || '', fieldCopyBtn);
    
    fieldRow.appendChild(fieldText);
    fieldRow.appendChild(fieldCopyBtn);
    valueDiv.appendChild(fieldRow);
  });

  expDiv.appendChild(headerDiv);
  expDiv.appendChild(valueDiv);

  return expDiv;
}

function createEducationField(edu, num) {
  const eduDiv = document.createElement('div');
  eduDiv.className = 'info-field';
  eduDiv.style.marginBottom = '12px';

  const headerDiv = document.createElement('div');
  headerDiv.className = 'info-field-header';

  const label = document.createElement('div');
  label.className = 'info-label';
  label.textContent = `Education ${num}`;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-copy-small';
  copyBtn.textContent = 'Copy All';
  const eduText = `Degree: ${formatValue(edu.degree, 'degree')}\nSchool: ${formatValue(edu.school, 'school')}\nStart: ${formatValue(edu.start || edu.startDate, 'start')}\nEnd: ${formatValue(edu.end || edu.endDate, 'end')}\nGPA: ${formatValue(edu.gpa, 'gpa')}\nLocation: ${formatValue(edu.location, 'location')}`;
  copyBtn.onclick = () => copyToClipboard(eduText, copyBtn);

  headerDiv.appendChild(label);
  headerDiv.appendChild(copyBtn);

  const valueDiv = document.createElement('div');
  valueDiv.className = 'info-value';

  const fields = [
    { label: 'Degree', value: edu.degree },
    { label: 'School', value: edu.school },
    { label: 'Start', value: edu.start || edu.startDate },
    { label: 'End', value: edu.end || edu.endDate },
    { label: 'GPA', value: edu.gpa },
    { label: 'Location', value: edu.location }
  ];

  fields.forEach(field => {
    const fieldRow = document.createElement('div');
    fieldRow.style.display = 'flex';
    fieldRow.style.justifyContent = 'space-between';
    fieldRow.style.alignItems = 'center';
    fieldRow.style.marginBottom = '6px';
    fieldRow.style.padding = '4px 0';

    const fieldText = document.createElement('span');
    const rendered = formatValue(field.value, field.label);
    fieldText.innerHTML = `<strong>${field.label}:</strong> ${rendered || 'N/A'}`;

    const fieldCopyBtn = document.createElement('button');
    fieldCopyBtn.className = 'btn-copy-tiny';
    fieldCopyBtn.textContent = 'Copy';
    fieldCopyBtn.onclick = () => copyToClipboard(rendered || '', fieldCopyBtn);

    fieldRow.appendChild(fieldText);
    fieldRow.appendChild(fieldCopyBtn);
    valueDiv.appendChild(fieldRow);
  });

  eduDiv.appendChild(headerDiv);
  eduDiv.appendChild(valueDiv);

  return eduDiv;
}

function formatLabel(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .trim()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatValue(value, key = '') {
  if (value === null || value === undefined) return '';

  // Strings
  if (typeof value === 'string') {
    const v = value.trim();

    // Format YYYY-MM-DD dates
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, m, d] = v.split('-');
      return `${m}/${d}/${y}`;
    }

    // Format phone-like values (US 10-digit)
    if (String(key).toLowerCase().includes('phone')) {
      const digits = v.replace(/\D/g, '');
      if (digits.length === 10) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      }
      return v;
    }

    // Make long comma-separated lists easier to read
    if (key === 'companiesWorked' && v.includes(',')) {
      const parts = v.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length > 1) return `• ${parts.join('\n• ')}`;
    }

    return v;
  }

  // Arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return value.map(v => (typeof v === 'string' ? v.trim() : String(v))).join(', ');
  }

  // Objects
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}

async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const originalText = button.textContent;
    button.textContent = 'Copied!';
    setTimeout(() => {
      button.textContent = originalText;
    }, 2000);
  } catch (error) {
    console.error('Copy failed:', error);
    button.textContent = 'Failed';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 2000);
  }
}

function setupEventListeners() {
  document.getElementById('backBtn').addEventListener('click', () => {
    // Close side panel
    window.close();
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (confirm('Are you sure you want to logout?')) {
      await handleLogout();
    }
  });

  document.getElementById('startApplicationBtn').addEventListener('click', handleStartApplication);
  
  document.getElementById('studentDetailsBtn').addEventListener('click', handleStudentDetails);

  document.getElementById('downloadResumeBtn').addEventListener('click', handleDownloadResume);

  document.getElementById('coverLetterBtn').addEventListener('click', handleCoverLetter);

  document.getElementById('appliedBtn').addEventListener('click', handleApplied);

  document.getElementById('comeAtLastBtn').addEventListener('click', handleComeAtLast);

  document.getElementById('skipJobBtn').addEventListener('click', handleSkipJob);

  document.getElementById('saveNotesBtn').addEventListener('click', handleSaveNotes);

  document.getElementById('copyLinkBtn').addEventListener('click', async () => {
    const button = document.getElementById('copyLinkBtn');
    await copyToClipboard(currentJob.jobLink, button);
  });

  document.getElementById('backToStudentsBtn')?.addEventListener('click', () => {
    window.close();
  });

  // Load notes for this student
  loadStudentNotes();
}

async function handleComeAtLast() {
  const btn = document.getElementById('comeAtLastBtn');

  if (isProcessing) return;
  if (!currentJob || !currentJob.jobId) {
    showError('No job loaded');
    return;
  }

  if (!confirm('Move this job to the end of the queue?')) return;

  const jobIdAtStart = currentJob.jobId;
  const emailAtStart = currentJob.email;

  // Stop and upload recording silently
  stopAndUploadRecording(jobIdAtStart, emailAtStart, 'come_at_last');

  try {
    isProcessing = true;
    setAllButtonsDisabled(true);
    btn.textContent = 'Moving...';

    // Clear currentJob during transition
    currentJob = null;

    const response = await fetch(
      `${API.COME_AT_LAST}?job_id=${encodeURIComponent(jobIdAtStart)}&email=${encodeURIComponent(emailAtStart)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${currentToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      showError(data.message || 'Failed to move job');
      // Restore currentJob on failure
      currentJob = { jobId: jobIdAtStart, email: emailAtStart };
      btn.textContent = 'Come at Last';
      return;
    }

    // Hide student info section
    const studentInfoSection = document.getElementById('studentInfoSection');
    if (studentInfoSection) studentInfoSection.style.display = 'none';

    // Load next job from response
    if (data.nextJob) {
      displayJob(data.nextJob);
    } else {
      document.getElementById('jobContent').style.display = 'none';
      document.getElementById('noJobsMessage').style.display = 'block';
    }

    btn.textContent = 'Come at Last';

  } catch (error) {
    console.error('Error moving job:', error);
    showError('Failed to move job to end of queue');
    if (!currentJob) currentJob = { jobId: jobIdAtStart, email: emailAtStart };
    btn.textContent = 'Come at Last';
  } finally {
    isProcessing = false;
    setAllButtonsDisabled(false);
  }
}

function showSkipReasonModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;width:100%;max-width:440px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);max-height:90vh;display:flex;flex-direction:column;">
        <div style="background:#000;color:#fff;padding:14px 20px;font-size:15px;font-weight:700;border-left:5px solid #c0392b;">
          ⚠️ Skip Job — Justify Your Reason
        </div>
        <div style="padding:18px 20px 14px;overflow-y:auto;">
          <div style="background:#fff4f4;border:1px solid #f3c0c0;color:#a33;padding:9px 12px;border-radius:6px;font-size:12px;font-weight:600;margin-bottom:14px;line-height:1.4;">
            Skips are reviewed. Incorrect skips may result in termination.<br>
            Ask your team lead if unsure.
          </div>

          <div style="font-size:12px;color:#1f7a3a;font-weight:700;margin-bottom:6px;">✅ You can skip only if:</div>
          <ul style="font-size:12px;color:#333;margin:0 0 12px 18px;padding:0;line-height:1.5;list-style:disc;">
            <li><b>Website problem</b> — broken page, captcha, login error</li>
            <li><b>Application limit</b> — daily quota, "already applied" wall</li>
            <li><b>Student info missing</b> — unresponsive, SSN not provided</li>
          </ul>

          <div style="font-size:12px;color:#a33;font-weight:700;margin-bottom:4px;">❌ Not acceptable:</div>
          <p style="font-size:12px;color:#555;margin:0 0 14px;line-height:1.5;">
            Skipping without any of the problems above, or because of an incorrect password.
          </p>

          <label style="display:block;font-size:12px;color:#333;font-weight:600;margin-bottom:6px;">Which applies + brief detail:</label>
          <textarea id="skipReasonText" rows="3" placeholder="e.g. Website problem — login page returned 500 after 3 retries" style="width:100%;padding:10px;border:2px solid #ccc;border-radius:7px;font-size:13px;resize:vertical;box-sizing:border-box;font-family:inherit;"></textarea>

          <div style="margin-top:14px;padding:10px 12px;background:#f5f5f5;border:1px solid #ddd;border-radius:6px;">
            <div style="font-size:12px;color:#333;font-weight:600;margin-bottom:8px;">Block next replacement from:</div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:6px;">
              <input type="checkbox" id="skipAmazonCheck" style="width:14px;height:14px;accent-color:#000;" />
              <span style="font-size:12px;color:#000;">Skip Amazon jobs</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="skipGoogleCheck" style="width:14px;height:14px;accent-color:#000;" />
              <span style="font-size:12px;color:#000;">Skip Google jobs</span>
            </label>
          </div>
        </div>
        <div style="padding:0 20px 18px;display:flex;gap:10px;">
          <button id="skipCancelBtn" style="flex:1;padding:11px;background:#fff;color:#000;border:2px solid #000;border-radius:7px;font-size:13px;font-weight:700;cursor:pointer;">Cancel</button>
          <button id="skipConfirmBtn" style="flex:1;padding:11px;background:#ccc;color:#888;border:none;border-radius:7px;font-size:13px;font-weight:700;cursor:not-allowed;" disabled>Skip Job</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const textarea = overlay.querySelector('#skipReasonText');
    const confirmBtn = overlay.querySelector('#skipConfirmBtn');
    const cancelBtn = overlay.querySelector('#skipCancelBtn');
    const amazonCheck = overlay.querySelector('#skipAmazonCheck');
    const googleCheck = overlay.querySelector('#skipGoogleCheck');

    textarea.focus();

    textarea.addEventListener('input', () => {
      const hasText = textarea.value.trim().length > 0;
      confirmBtn.disabled = !hasText;
      confirmBtn.style.background = hasText ? '#c0392b' : '#ccc';
      confirmBtn.style.color = hasText ? '#fff' : '#888';
      confirmBtn.style.cursor = hasText ? 'pointer' : 'not-allowed';
    });

    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve(null);
    });

    confirmBtn.addEventListener('click', () => {
      const reason = textarea.value.trim();
      if (!reason) return;
      const skipCompanies = [];
      if (amazonCheck.checked) skipCompanies.push('amazon');
      if (googleCheck.checked) skipCompanies.push('google');
      document.body.removeChild(overlay);
      resolve({ reason, skipCompanies });
    });
  });
}

async function handleSkipJob() {
  const btn = document.getElementById('skipJobBtn');

  if (isProcessing) return;
  if (!currentJob || !currentJob.jobId) {
    showError('No job loaded');
    return;
  }

  const skipResult = await showSkipReasonModal();
  if (!skipResult) return; // User cancelled
  const { reason: skipReason, skipCompanies } = skipResult;

  const jobIdAtStart = currentJob.jobId;
  const emailAtStart = currentJob.email;

  // Stop and upload recording silently — include skip reason
  stopAndUploadRecording(jobIdAtStart, emailAtStart, 'skipped', skipReason);

  try {
    isProcessing = true;
    setAllButtonsDisabled(true);
    btn.textContent = 'Skipping...';

    // Clear currentJob during transition
    currentJob = null;

    const response = await fetchWithRetry(API.SKIP_JOB, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jobId: jobIdAtStart,
        email: emailAtStart,
        skipReason: skipReason,
        skipCompanies: skipCompanies
      })
    }, { attempts: 3, baseDelayMs: 800, label: 'skip-job' });

    const data = await response.json();

    if (!response.ok || !data.success) {
      showError(data.message || 'Failed to skip job');
      // Restore currentJob on failure
      currentJob = { jobId: jobIdAtStart, email: emailAtStart };
      btn.textContent = 'Skip Job';
      return;
    }

    // Hide student info section
    const studentInfoSection = document.getElementById('studentInfoSection');
    if (studentInfoSection) studentInfoSection.style.display = 'none';

    // Load next job from response
    if (data.nextJob) {
      displayJob(data.nextJob);
    } else {
      document.getElementById('jobContent').style.display = 'none';
      document.getElementById('noJobsMessage').style.display = 'block';
    }

    btn.textContent = 'Skip Job';

  } catch (error) {
    console.error('Error skipping job:', error);
    showError('Failed to skip job');
    if (!currentJob) currentJob = { jobId: jobIdAtStart, email: emailAtStart };
    btn.textContent = 'Skip Job';
  } finally {
    isProcessing = false;
    setAllButtonsDisabled(false);
  }
}

async function loadStudentNotes() {
  try {
    const response = await fetch(
      `${API.STUDENT_NOTES}?email=${encodeURIComponent(currentStudent.email)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${currentToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await response.json();
    if (data.success && data.note) {
      document.getElementById('studentNotes').value = data.note;
    }
  } catch (error) {
    console.error('Error loading notes:', error);
  }
}

async function handleSaveNotes() {
  const btn = document.getElementById('saveNotesBtn');
  const note = document.getElementById('studentNotes').value.trim();

  try {
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const response = await fetch(API.STUDENT_NOTES, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: currentStudent.email,
        note: note
      })
    });

    const data = await response.json();

    if (data.success) {
      btn.textContent = 'Saved!';
    } else {
      showError('Failed to save notes');
      btn.textContent = 'Save Notes';
    }

    setTimeout(() => {
      btn.textContent = 'Save Notes';
      btn.disabled = false;
    }, 2000);

  } catch (error) {
    console.error('Error saving notes:', error);
    showError('Failed to save notes');
    btn.disabled = false;
    btn.textContent = 'Save Notes';
  }
}

async function handleLogout() {
  try {
    await fetch(API.LOGOUT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Logout error:', error);
  } finally {
    await chrome.storage.local.clear();
    window.location.href = '../auth/login.html';
  }
}

function showError(message) {
  const errorMessage = document.getElementById('errorMessage');
  errorMessage.textContent = message;
  errorMessage.style.display = 'block';
  setTimeout(() => {
    errorMessage.style.display = 'none';
  }, 5000);
}