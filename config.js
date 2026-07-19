// config.js
export const CONFIG = {
  TOKEN_KEY: 'axzoraJobApplierToken',
  USER_KEY: 'axzoraJobApplierUser',
  CURRENT_STUDENT_KEY: 'axzoraCurrentStudent',
  CURRENT_JOB_KEY: 'axzoraCurrentJob',
  EXTENSION_VERSION: '1.0.0'
};

const BASE_URL = 'https://job-extension-background.onrender.com/api';

export const API = {
  BASE_URL: BASE_URL,

  // Job Applier endpoints
  LOGIN: `${BASE_URL}/jobapplier/login`,
  ASSIGNED_STUDENTS: `${BASE_URL}/jobapplier/assigned-students`,
  STUDENT_JOBS: `${BASE_URL}/jobapplier/student-jobs`,
  STUDENT_INFO: `${BASE_URL}/jobapplier/student-info`,
  MARK_JOB_STARTED: `${BASE_URL}/jobapplier/mark-job-started`,
  MARK_JOB_APPLIED: `${BASE_URL}/jobapplier/mark-job-applied`,
  JOB_RESUME: `${BASE_URL}/jobapplier/job-resume`,
  LOGOUT: `${BASE_URL}/jobapplier/logout`,
  AI_ANSWER: `${BASE_URL}/jobapplier/ai-answer`,
  TARGET_COMPENSATION: `${BASE_URL}/jobapplier/target-compensation`,
  COME_AT_LAST: `${BASE_URL}/jobapplier/come-at-last`,
  SKIP_JOB: `${BASE_URL}/jobapplier/skip-job`,
  STUDENT_NOTES: `${BASE_URL}/jobapplier/student-notes`,

  // New endpoints
  VERSION_CHECK: `${BASE_URL}/jobapplier/version-check`,
  SUBMIT_SCREENSHOT: `${BASE_URL}/jobapplier/submit-screenshot`,
  SCREENSHOT_STATUS: `${BASE_URL}/jobapplier/screenshot-status`,
  STUDENT_COMPLETION_STATUS: `${BASE_URL}/jobapplier/student-completion-status`,
  STUDENTS_SUMMARY: `${BASE_URL}/jobapplier/students-summary`,
  UPLOAD_RECORDING: `${BASE_URL}/jobapplier/upload-recording`,

  // Cover Letter microservice
  GENERATE_COVER_LETTER: 'https://cover-letter-service.onrender.com/api/generate-cover-letter',
};