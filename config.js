// config.js
export const CONFIG = {
  TOKEN_KEY: 'axzoraJobApplierToken',
  USER_KEY: 'axzoraJobApplierUser',
  CURRENT_STUDENT_KEY: 'axzoraCurrentStudent',
  CURRENT_JOB_KEY: 'axzoraCurrentJob',
  EXTENSION_VERSION: '1.0.0'
};

const BASE_URL = 'https://axzora-backend.onrender.com/api/axzora';

export const API = {
  BASE_URL: BASE_URL,

  // Job Applier endpoints
  LOGIN: `${BASE_URL}/login`,
  ASSIGNED_STUDENTS: `${BASE_URL}/assigned-students`,
  STUDENT_JOBS: `${BASE_URL}/student-jobs`,
  STUDENT_INFO: `${BASE_URL}/student-info`,
  MARK_JOB_STARTED: `${BASE_URL}/mark-job-started`,
  MARK_JOB_APPLIED: `${BASE_URL}/mark-job-applied`,
  JOB_RESUME: `${BASE_URL}/job-resume`,
  LOGOUT: `${BASE_URL}/logout`,
  AI_ANSWER: `${BASE_URL}/ai-answer`,
  TARGET_COMPENSATION: `${BASE_URL}/target-compensation`,
  COME_AT_LAST: `${BASE_URL}/come-at-last`,
  SKIP_JOB: `${BASE_URL}/skip-job`,
  STUDENT_NOTES: `${BASE_URL}/student-notes`,

  // New endpoints
  VERSION_CHECK: `${BASE_URL}/version-check`,
  SUBMIT_SCREENSHOT: `${BASE_URL}/submit-screenshot`,
  SCREENSHOT_STATUS: `${BASE_URL}/screenshot-status`,
  STUDENT_COMPLETION_STATUS: `${BASE_URL}/student-completion-status`,
  STUDENTS_SUMMARY: `${BASE_URL}/students-summary`,
  UPLOAD_RECORDING: `${BASE_URL}/upload-recording`,

  // Cover Letter microservice
  GENERATE_COVER_LETTER: `${BASE_URL}/generate-cover-letter`,
};
