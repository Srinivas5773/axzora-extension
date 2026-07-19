// offscreen.js — hidden page, receives streamId and records via getUserMedia

let recordingState = {
  mediaRecorder: null,
  chunks: [],
  stream: null,
  jobId: null,
  studentEmail: null,
  applierEmail: null,
  autoStopTimer: null
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.target !== 'offscreen') return;

  if (message.action === 'startRecording') {
    const { streamId, jobId, studentEmail, applierEmail } = message;

    // Stop any existing recording first
    if (recordingState.mediaRecorder &&
        recordingState.mediaRecorder.state !== 'inactive') {
      try { recordingState.mediaRecorder.stop(); } catch(e) {}
      if (recordingState.stream) {
        recordingState.stream.getTracks().forEach(t => t.stop());
      }
      if (recordingState.autoStopTimer) clearTimeout(recordingState.autoStopTimer);
    }

    recordingState = {
      mediaRecorder: null,
      chunks: [],
      stream: null,
      jobId,
      studentEmail,
      applierEmail,
      autoStopTimer: null
    };

    // Use streamId from background to get the media stream
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId
      }
    }).then((stream) => {

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp8',
        videoBitsPerSecond: 300000
      });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordingState.chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        recordingState.stream = null;
      };

      // Handle stream ending unexpectedly (tab closed)
      stream.getVideoTracks()[0].onended = () => {
        console.log('Tab stream ended unexpectedly');
        if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      };

      // Auto-stop after 10 minutes
      recordingState.autoStopTimer = setTimeout(() => {
        if (mediaRecorder.state !== 'inactive') {
          console.log('Recording auto-stopped after 10 mins');
          mediaRecorder.stop();
        }
      }, 10 * 60 * 1000);

      recordingState.mediaRecorder = mediaRecorder;
      recordingState.stream = stream;
      mediaRecorder.start(30000); // chunk every 30s — matches student.js
      console.log(`Recording started — job: ${jobId}`);
      sendResponse({ success: true });

    }).catch((err) => {
      console.error('getUserMedia failed:', err.name, err.message, err.constraint);
      sendResponse({ success: false, reason: err.name + ': ' + err.message });
    });

    return true; // async
  }

  if (message.action === 'stopRecording') {
    if (!recordingState.mediaRecorder ||
        recordingState.mediaRecorder.state === 'inactive') {
      sendResponse({ success: false, reason: 'not_recording' });
      return true;
    }

    if (recordingState.autoStopTimer) {
      clearTimeout(recordingState.autoStopTimer);
      recordingState.autoStopTimer = null;
    }

    const { jobId, studentEmail, applierEmail } = recordingState;

    recordingState.mediaRecorder.addEventListener('stop', () => {
      const blob = new Blob(recordingState.chunks, { type: 'video/webm' });
      console.log(`Recording stopped — job: ${jobId}, size: ${blob.size} bytes`);

      // Free chunks from memory immediately — blob already holds the data
      recordingState.chunks = [];

      // Send blob directly instead of Base64 to avoid memory spike
      sendResponse({
        success: true,
        jobId,
        studentEmail,
        applierEmail,
        videoBlob: blob,
        size: blob.size
      });

      recordingState = {
        mediaRecorder: null,
        chunks: [],
        stream: null,
        jobId: null,
        studentEmail: null,
        applierEmail: null,
        autoStopTimer: null
      };
    });

    recordingState.mediaRecorder.stop();
    return true; // async
  }

});
