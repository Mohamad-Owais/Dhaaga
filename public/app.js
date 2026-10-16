/* ==========================================================================
   Dhaaga (धागा) — Frontend Logic & Audio Interaction Engine
   Record or upload audio -> /api/transcribe -> /api/translate -> Heirloom card
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    language: $('language'),
    recordBtn: $('recordBtn'),
    recordLabel: $('recordLabel'),
    timer: $('timer'),
    recordStatus: $('recordStatus'),
    recordStage: $('recordStage'),
    stepTranscribe: $('stepTranscribe'),
    stepTranslate: $('stepTranslate'),
    weaveLabel: document.querySelector('#weaveBtn .primary-label'),
    audioFile: $('audioFile'),
    fileName: $('fileName'),
    preview: $('preview'),
    previewAudio: $('previewAudio'),
    weaveBtn: $('weaveBtn'),
    statusBar: $('statusBar'),
    statusText: $('statusText'),
    errorBar: $('errorBar'),
    result: $('result'),
    transcriptText: $('transcriptText'),
    storyTitle: $('storyTitle'),
    storyBody: $('storyBody'),
    storyCard: $('storyCard'),
    storyDate: $('storyDate'),
    copyBtn: $('copyBtn'),
    printBtn: $('printBtn'),
    resetBtn: $('resetBtn'),
    downloadAudioBtn: $('downloadAudioBtn'),

    // Redesign interactive extensions
    tabRecord: $('tabRecord'),
    tabUpload: $('tabUpload'),
    panelRecord: $('panelRecord'),
    panelUpload: $('panelUpload'),
    dropZone: $('dropZone'),
    langChips: $('langChips'),
    waveformCanvas: $('waveformCanvas'),
    waveformFallback: $('waveformFallback'),
    themeToggleBtn: $('themeToggleBtn'),
    viewBtnEnglish: $('viewBtnEnglish'),
    viewBtnDual: $('viewBtnDual'),
    viewBtnOriginal: $('viewBtnOriginal'),
  };

  var MAX_SECONDS = 30;

  var state = {
    mediaRecorder: null,
    audioStream: null,
    audioContext: null,
    analyser: null,
    animFrameId: null,
    chunks: [],
    recordedBlob: null,
    recordedUrl: null,
    file: null,
    recording: false,
    timerId: null,
    elapsed: 0,
    busy: false,
  };

  // Sample curated stories for instant preview
  var sampleStories = {
    kashmiri: {
      title: "The First Frost on the Chinars",
      translated: "When the autumn turned golden, my father would kindle the small wicker kangri with dried apple wood coals. Early in the morning, the Dal lake wore a veil of steam so thick you could only hear the boatman's oar splashing across the quiet water. We wrapped ourselves in warm wool blankets and waited for the noon sun to touch the mountains.",
      transcript: "ییلہ ریتھکال سونہہری گوو، بابہٕ چھِ ترٛاٹھی کَنٛگٕرؠ پؠٹھ ژوٗنٛٹھی کٕٹؠ پؠٹھ نار لگاون۔ صُبحَس اوس ڈال اۆل کُہَر ہِندِ لَبادَس منٛز، صِرف ناوی حَنٛز اوس باسان...",
      lang: "ks-IN",
      langName: "Kashmiri"
    },
    hindi: {
      title: "The Copper Kettle of Ballimaran",
      translated: "My grandfather bought that heavy copper kettle right after the great monsoon of 1968. Every morning at five, cardamom pods and crushed ginger simmered on the stove while the narrow lane slowly woke to the flutter of rooftop pigeons. The smell of that tea could bring the entire family into the courtyard without a single word called.",
      transcript: "दादाजी ने वह तांबे की केतली 1968 की बरसात के ठीक बाद खरीदी थी। रोज़ सुबह पाँच बजे चूल्हे पर इलायची और कुटी हुई अदरक खौलती थी और गली में कबूतरों के पंखों की फड़फड़ाहट गूँजती थी...",
      lang: "hi-IN",
      langName: "Hindi"
    },
    urdu: {
      title: "The Jasmine Plant in the Courtyard",
      translated: "My mother would water the nighttime jasmine with water left from boiling white chickpeas. At night, when the heavy ceiling fan hummed its slow, rhythmic song, the courtyard smelled so sweet and peaceful that you did not need lullabies or words to slip into dreams.",
      transcript: "امی رات کی رانی کے پودے کو ابلے ہوئے چنوں کے بچے ہوئے پانی سے سینچتی تھیں۔ رات کو جب پنکھا دھیمی رفتار سے گھومتا تھا تو صحن میں ایسی بھینی خوشبو پھیلتی تھی کہ کسی لوری کی ضرورت ہی نہیں پڑتی تھی...",
      lang: "ur-IN",
      langName: "Urdu"
    }
  };

  // ---- helpers ----------------------------------------------------------
  function showError(msg) {
    if (els.errorBar) {
      els.errorBar.textContent = msg;
      els.errorBar.hidden = false;
    }
  }
  function clearError() {
    if (els.errorBar) {
      els.errorBar.hidden = true;
      els.errorBar.textContent = '';
    }
  }
  function setStatus(msg) {
    if (!els.statusBar || !els.statusText) return;
    if (msg) {
      els.statusText.textContent = msg;
      els.statusBar.hidden = false;
    } else {
      els.statusBar.hidden = true;
    }
  }
  function fmt(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function setRecordStatus(text, live) {
    if (els.recordStatus) {
      els.recordStatus.textContent = text;
      els.recordStatus.classList.toggle('live', !!live);
    }
  }
  function updateWeaveState() {
    var ready = Boolean(state.recordedBlob || state.file) && !state.busy;
    if (els.weaveBtn) els.weaveBtn.disabled = !ready;
  }

  // Visual stage of the recorder: idle | recording | ready | processing
  function setStage(stage) {
    if (els.recordStage) els.recordStage.dataset.stage = stage;
  }

  // Two-step progress: null | 'transcribe' | 'translate'
  function setProgress(step) {
    if (!els.stepTranscribe || !els.stepTranslate) return;
    els.stepTranscribe.classList.remove('active', 'done');
    els.stepTranslate.classList.remove('active', 'done');
    if (step === 'transcribe') {
      els.stepTranscribe.classList.add('active');
    } else if (step === 'translate') {
      els.stepTranscribe.classList.add('done');
      els.stepTranslate.classList.add('active');
    }
  }

  function updateStoryDate() {
    if (!els.storyDate) return;
    var now = new Date();
    var options = { year: 'numeric', month: 'long', day: 'numeric' };
    els.storyDate.textContent = now.toLocaleDateString('en-US', options);
  }

  function pickMimeType() {
    var candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function extensionFor(mime) {
    if (/webm/.test(mime)) return 'webm';
    if (/ogg/.test(mime)) return 'ogg';
    if (/mp4|m4a|aac/.test(mime)) return 'm4a';
    if (/mpeg|mp3/.test(mime)) return 'mp3';
    if (/wav/.test(mime)) return 'wav';
    return 'webm';
  }

  // ---- Audio Visualizer (Waveform Canvas) -------------------------------
  function initVisualizer(stream) {
    if (!els.waveformCanvas) return;
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      if (els.waveformFallback) els.waveformFallback.style.display = 'flex';
      return;
    }

    try {
      if (!state.audioContext) {
        state.audioContext = new AudioCtx();
      } else if (state.audioContext.state === 'suspended') {
        state.audioContext.resume();
      }

      var source = state.audioContext.createMediaStreamSource(stream);
      var analyser = state.audioContext.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      state.analyser = analyser;

      var canvas = els.waveformCanvas;
      var ctx = canvas.getContext('2d');
      var bufferLength = analyser.frequencyBinCount;
      var dataArray = new Uint8Array(bufferLength);

      function renderFrame() {
        if (!state.recording) return;
        state.animFrameId = requestAnimationFrame(renderFrame);
        analyser.getByteFrequencyData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        var barWidth = (canvas.width / bufferLength) * 2.2;
        var barHeight;
        var x = 0;

        for (var i = 0; i < bufferLength; i++) {
          barHeight = (dataArray[i] / 255) * canvas.height * 0.9;
          if (barHeight < 4) barHeight = 4;

          var grad = ctx.createLinearGradient(0, canvas.height, 0, 0);
          grad.addColorStop(0, '#b44f33');
          grad.addColorStop(0.5, '#c68a35');
          grad.addColorStop(1, '#e5a55d');

          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.roundRect(x, (canvas.height - barHeight) / 2, barWidth - 3, barHeight, 4);
          ctx.fill();

          x += barWidth;
        }
      }

      renderFrame();
    } catch (e) {
      if (els.waveformFallback) els.waveformFallback.style.display = 'flex';
    }
  }

  function stopVisualizer() {
    if (state.animFrameId) {
      cancelAnimationFrame(state.animFrameId);
      state.animFrameId = null;
    }
    if (els.waveformCanvas) {
      var ctx = els.waveformCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, els.waveformCanvas.width, els.waveformCanvas.height);
    }
    if (els.waveformFallback) els.waveformFallback.style.display = 'none';
  }

  // ---- recording --------------------------------------------------------
  function startRecording() {
    if (state.busy) return;
    clearError();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('Your browser does not support microphone recording. Please upload an audio file instead.');
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        state.audioStream = stream;
        state.chunks = [];
        var mime = pickMimeType();
        var opts = mime ? { mimeType: mime } : undefined;

        var recorder;
        try {
          recorder = new MediaRecorder(stream, opts);
        } catch (e) {
          recorder = new MediaRecorder(stream);
        }
        state.mediaRecorder = recorder;

        recorder.ondataavailable = function (ev) {
          if (ev.data && ev.data.size > 0) state.chunks.push(ev.data);
        };
        recorder.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          stopVisualizer();
          finishRecording(recorder.mimeType || mime || 'audio/webm');
        };

        recorder.start(250);
        state.recording = true;
        state.elapsed = 0;
        setStage('recording');
        setProgress(null);
        els.recordBtn.classList.add('recording');
        els.recordBtn.setAttribute('aria-pressed', 'true');
        els.recordLabel.textContent = 'Stop recording';
        els.timer.textContent = fmt(0);
        setRecordStatus('Listening closely — recording memory…', true);

        initVisualizer(stream);

        state.timerId = setInterval(function () {
          state.elapsed += 1;
          els.timer.textContent = fmt(state.elapsed);
          if (state.elapsed >= MAX_SECONDS) stopRecording();
        }, 1000);
      })
      .catch(function (err) {
        var name = err && err.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          showError('Microphone access was blocked. Allow microphone permission in your browser, or upload an audio file.');
        } else if (name === 'NotFoundError') {
          showError('No microphone was detected on this device. You can upload an audio note instead.');
        } else {
          showError('We could not start the microphone. Please upload an audio file instead.');
        }
      });
  }

  function stopRecording() {
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      state.mediaRecorder.stop();
    }
    state.recording = false;
    els.recordBtn.classList.remove('recording');
    els.recordBtn.setAttribute('aria-pressed', 'false');
    els.recordLabel.textContent = 'Start recording';
    setRecordStatus('Recording captured', false);
  }

  function finishRecording(mime) {
    if (!state.chunks.length) {
      setStage('idle');
      setRecordStatus('Nothing was captured', false);
      showError('The recording was empty. Please try again, a little closer to the microphone.');
      return;
    }
    var blob = new Blob(state.chunks, { type: mime });
    if (!blob.size) {
      setStage('idle');
      showError('The recording was empty. Please try again.');
      return;
    }
    if (state.recordedUrl) URL.revokeObjectURL(state.recordedUrl);
    state.recordedBlob = blob;
    state.recordedUrl = URL.createObjectURL(blob);

    // A recording supersedes any previously chosen file.
    state.file = null;
    els.audioFile.value = '';
    els.fileName.hidden = true;

    els.previewAudio.src = state.recordedUrl;
    els.preview.hidden = false;
    setStage('ready');
    els.recordLabel.textContent = 'Record again';
    setRecordStatus('Voice note ready · ' + fmt(state.elapsed), false);
    updateWeaveState();
  }

  // ---- file upload ------------------------------------------------------
  function handleSelectedFile(f) {
    clearError();
    if (!f) return;
    if (!(f.type.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|webm|opus|aac|flac)$/i.test(f.name))) {
      showError('That file does not look like audio. Please choose a WAV, MP3, M4A, OGG or WebM file.');
      els.audioFile.value = '';
      return;
    }
    state.file = f;
    els.fileName.textContent = 'Chosen: ' + f.name + ' (' + Math.round(f.size / 1024) + ' KB)';
    els.fileName.hidden = false;

    // A chosen file supersedes any previous recording.
    state.recordedBlob = null;
    if (state.recordedUrl) { URL.revokeObjectURL(state.recordedUrl); state.recordedUrl = null; }
    
    // Set preview to uploaded file
    state.recordedUrl = URL.createObjectURL(f);
    els.previewAudio.src = state.recordedUrl;
    els.preview.hidden = false;

    setStage('ready');
    els.recordLabel.textContent = 'Start recording';
    setRecordStatus('Audio note attached', false);
    updateWeaveState();
  }

  els.audioFile.addEventListener('change', function () {
    var f = els.audioFile.files && els.audioFile.files[0];
    handleSelectedFile(f);
  });

  // Drag and drop support
  if (els.dropZone) {
    ['dragenter', 'dragover'].forEach(function (eventName) {
      els.dropZone.addEventListener(eventName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        els.dropZone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (eventName) {
      els.dropZone.addEventListener(eventName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        els.dropZone.classList.remove('dragover');
      });
    });
    els.dropZone.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      var files = dt && dt.files;
      if (files && files.length) {
        handleSelectedFile(files[0]);
      }
    });
  }

  // ---- tabs: record vs upload -------------------------------------------
  if (els.tabRecord && els.tabUpload) {
    els.tabRecord.addEventListener('click', function () {
      els.tabRecord.classList.add('active');
      els.tabUpload.classList.remove('active');
      els.tabRecord.setAttribute('aria-selected', 'true');
      els.tabUpload.setAttribute('aria-selected', 'false');
      els.panelRecord.classList.add('active');
      els.panelRecord.hidden = false;
      els.panelUpload.classList.remove('active');
      els.panelUpload.hidden = true;
    });

    els.tabUpload.addEventListener('click', function () {
      els.tabUpload.classList.add('active');
      els.tabRecord.classList.remove('active');
      els.tabUpload.setAttribute('aria-selected', 'true');
      els.tabRecord.setAttribute('aria-selected', 'false');
      els.panelUpload.classList.add('active');
      els.panelUpload.hidden = false;
      els.panelRecord.classList.remove('active');
      els.panelRecord.hidden = true;
    });
  }

  // ---- language quick selector pills ------------------------------------
  if (els.langChips) {
    els.langChips.addEventListener('click', function (e) {
      var chip = e.target.closest('.lang-chip');
      if (!chip) return;
      var lang = chip.dataset.lang;
      if (!lang) return;

      els.language.value = lang;
      var allChips = els.langChips.querySelectorAll('.lang-chip');
      allChips.forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
    });

    els.language.addEventListener('change', function () {
      var currentVal = els.language.value;
      var allChips = els.langChips.querySelectorAll('.lang-chip');
      allChips.forEach(function (c) {
        c.classList.toggle('active', c.dataset.lang === currentVal);
      });
    });
  }

  // ---- record button ----------------------------------------------------
  els.recordBtn.addEventListener('click', function () {
    if (state.recording) stopRecording();
    else startRecording();
  });

  // ---- API calls & flow -------------------------------------------------
  function fetchJson(url, options) {
    return fetch(url, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var msg = (data && data.error) || ('Request failed (' + res.status + ').');
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  function weave() {
    if (state.busy) return;
    clearError();

    var source = state.recordedBlob || state.file;
    if (!source) {
      showError('Record a memory or choose an audio file first.');
      return;
    }
    var languageCode = els.language.value;
    var filename = state.recordedBlob
      ? 'memory.' + extensionFor(state.recordedBlob.type || 'audio/webm')
      : state.file.name;

    state.busy = true;
    updateWeaveState();
    if (els.weaveLabel) els.weaveLabel.textContent = 'Weaving memory…';
    els.result.hidden = true;
    setStage('processing');
    setProgress('transcribe');

    var form = new FormData();
    form.append('audio', source, filename);
    form.append('language_code', languageCode);

    setStatus('Listening closely — transcribing vernacular speech with Sarvam Saaras…');

    fetchJson('/api/transcribe', { method: 'POST', body: form })
      .then(function (data) {
        var transcript = (data.transcript || '').trim();
        els.transcriptText.textContent = transcript;
        els.transcriptText.setAttribute('lang', data.language_code || languageCode);

        setProgress('translate');
        setStatus('Weaving words into heirloom English prose with Sarvam Translate…');
        return fetchJson('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: transcript,
            source_language_code: data.language_code || languageCode,
          }),
        });
      })
      .then(function (data) {
        els.storyTitle.textContent = (data.title || 'A Memory to Keep');
        els.storyBody.textContent = (data.translated_text || '').trim();
        updateStoryDate();
        setProgress(null);
        setStatus('');
        setStage('ready');
        els.result.hidden = false;
        els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(function (err) {
        setProgress(null);
        setStatus('');
        setStage('ready');
        showError(err && err.message ? err.message : 'Something went wrong while weaving. Please try again.');
      })
      .then(function () {
        state.busy = false;
        if (els.weaveLabel) els.weaveLabel.textContent = 'Weave the thread';
        updateWeaveState();
      });
  }

  els.weaveBtn.addEventListener('click', weave);

  // ---- Story Card View Toggle (English, Dual, Original) -----------------
  function setCardView(view) {
    if (!els.storyCard) return;
    els.storyCard.dataset.view = view;
    if (els.viewBtnEnglish) els.viewBtnEnglish.classList.toggle('active', view === 'english');
    if (els.viewBtnDual) els.viewBtnDual.classList.toggle('active', view === 'dual');
    if (els.viewBtnOriginal) els.viewBtnOriginal.classList.toggle('active', view === 'original');
  }

  if (els.viewBtnEnglish) els.viewBtnEnglish.addEventListener('click', function () { setCardView('english'); });
  if (els.viewBtnDual) els.viewBtnDual.addEventListener('click', function () { setCardView('dual'); });
  if (els.viewBtnOriginal) els.viewBtnOriginal.addEventListener('click', function () { setCardView('original'); });

  // Story Card Theme Switcher (Parchment, Indigo, Terracotta)
  document.querySelectorAll('[data-card-theme]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var theme = btn.dataset.cardTheme;
      if (els.storyCard) els.storyCard.dataset.cardStyle = theme;
      document.querySelectorAll('[data-card-theme]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
      });
    });
  });

  // ---- Prompt Cards Click To Copy & Use --------------------------------
  document.querySelectorAll('.prompt-card').forEach(function (card) {
    card.addEventListener('click', function () {
      var q = card.querySelector('.prompt-q');
      if (!q) return;
      var text = q.textContent.replace(/^"|"$/g, '').trim();

      // Copy text to clipboard
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      }

      var hint = card.querySelector('.prompt-tap-hint');
      var original = hint ? hint.textContent : '';
      if (hint) hint.textContent = '✓ Copied to clipboard! Ready to ask.';

      // Scroll smoothly to studio
      $('studio').scrollIntoView({ behavior: 'smooth', block: 'start' });

      setTimeout(function () {
        if (hint) hint.textContent = original;
      }, 2500);
    });
  });

  // ---- Sample Stories Preview ------------------------------------------
  document.querySelectorAll('.btn-sample-load').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var sampleId = btn.dataset.sampleId;
      var sample = sampleStories[sampleId];
      if (!sample) return;

      els.storyTitle.textContent = sample.title;
      els.storyBody.textContent = sample.translated;
      els.transcriptText.textContent = sample.transcript;
      els.transcriptText.setAttribute('lang', sample.lang);
      updateStoryDate();

      setCardView('dual');
      els.result.hidden = false;
      els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // ---- Secondary Actions: Copy, Print, Download Audio ------------------
  els.copyBtn.addEventListener('click', function () {
    var text = els.storyTitle.textContent + '\n\n' +
      els.storyBody.textContent + '\n\n' +
      '— Spoken in ' + els.language.options[els.language.selectedIndex].text + '\n' +
      '— Preserved with Dhaaga (https://dhaaga.archive)';
    
    var done = function () {
      var original = els.copyBtn.innerHTML;
      els.copyBtn.innerHTML = '<span>✓ Copied</span>';
      setTimeout(function () { els.copyBtn.innerHTML = original; }, 1800);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        showError('Could not copy automatically. Please select text manually.');
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {
        showError('Could not copy automatically. Please select text manually.');
      }
      document.body.removeChild(ta);
    }
  });

  els.printBtn.addEventListener('click', function () { window.print(); });

  if (els.downloadAudioBtn) {
    els.downloadAudioBtn.addEventListener('click', function () {
      var sourceUrl = state.recordedUrl;
      if (!sourceUrl && state.file) {
        sourceUrl = URL.createObjectURL(state.file);
      }
      if (!sourceUrl) {
        showError('No audio recording is available to download.');
        return;
      }
      var a = document.createElement('a');
      a.href = sourceUrl;
      a.download = 'dhaaga-elder-memory-' + Date.now() + '.webm';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  els.resetBtn.addEventListener('click', function () {
    state.recordedBlob = null;
    if (state.recordedUrl) { URL.revokeObjectURL(state.recordedUrl); state.recordedUrl = null; }
    state.file = null;
    els.audioFile.value = '';
    els.fileName.hidden = true;
    els.previewAudio.removeAttribute('src');
    els.preview.hidden = true;
    els.result.hidden = true;
    els.transcriptText.textContent = '';
    els.storyTitle.textContent = '';
    els.storyBody.textContent = '';
    els.timer.textContent = '00:00';
    els.recordLabel.textContent = 'Start recording';
    setStage('idle');
    setProgress(null);
    setRecordStatus('Ready when you are', false);
    clearError();
    updateWeaveState();
    $('studio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---- Dark / Candlelight Theme Toggle ---------------------------------
  if (els.themeToggleBtn) {
    var savedTheme = localStorage.getItem('dhaaga-theme') || 'parchment';
    document.documentElement.setAttribute('data-theme', savedTheme);

    els.themeToggleBtn.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme') || 'parchment';
      var nextTheme = current === 'parchment' ? 'candlelight' : 'parchment';
      document.documentElement.setAttribute('data-theme', nextTheme);
      localStorage.setItem('dhaaga-theme', nextTheme);
    });
  }

  // ---- Startup ----------------------------------------------------------
  setCardView('english');
  updateWeaveState();
  updateStoryDate();

  fetch('/api/health')
    .then(function (r) { return r.json(); })
    .then(function (h) {
      if (h && h.configured === false) {
        showError('The server has no Sarvam API key yet. Add SARVAM_API_KEY to your .env file and restart.');
      }
    })
    .catch(function () { /* health check is best-effort */ });
})();
