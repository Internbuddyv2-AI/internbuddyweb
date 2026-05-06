(function mockInterviewPage(){
    const startBtn = document.getElementById('startBtn');
    const nextBtn = document.getElementById('nextBtn');
    const stopBtn = document.getElementById('stopBtn');
    const status = document.getElementById('status');
    const questionEl = document.getElementById('question');
    const feedbackEl = document.getElementById('feedback');
    const transcriptEl = document.getElementById('transcript');
    const voiceBar = document.getElementById('voiceBar');
    const webcam = document.getElementById('webcam');
  
    if (!startBtn || !nextBtn || !stopBtn || !status || !questionEl || !feedbackEl || !transcriptEl) return;
  
    const cfg = JSON.parse(sessionStorage.getItem('interviewConfig') || '{}');
  
    const askedIds = [];
    let currentQuestion = null;
    let round = 0;
    let recognition = null;
  
    function setSpeaking(on){
      if (!voiceBar) return;
      voiceBar.classList.toggle('quiet', !on);
    }
  
    /* ✅ Camera: video only (no mic audio routed to speakers) */
    async function initCamera(){
      try{
        const stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
        if (webcam) {
          webcam.srcObject = stream;
          webcam.muted = true;
          webcam.volume = 0;
        }
      } catch(e){
        console.warn('camera error', e);
        status.textContent = 'Camera permission denied. Continuing.';
      }
    }
  
    /* =========================
       AVATAR (Three.js classic)
    ========================= */
    let avatar = {
      renderer: null,
      scene: null,
      camera: null,
      meshWithMorphs: null,
      morphIndex: null,
      analyser: null,
      audioCtx: null,
      dataArray: null,
      mediaSource: null
    };
  
    function findMouthMorph(mesh) {
      const candidates = ['jawOpen','JawOpen','mouthOpen','MouthOpen','viseme_aa','viseme_AA'];
      const dict = mesh.morphTargetDictionary || {};
      for (const name of candidates) {
        if (dict[name] !== undefined) return dict[name];
      }
      return null;
    }
  
    async function initAvatar() {
      const stage = document.getElementById('avatarStage');
      if (!stage) {
        console.error('avatarStage not found');
        return;
      }
      if (!window.THREE || !THREE.GLTFLoader) {
        console.error('Three.js or GLTFLoader not loaded');
        status.textContent = 'Avatar libs not loaded (check console).';
        return;
      }
  
      const w = stage.clientWidth || 420;
      const h = stage.clientHeight || 420;
  
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, w/h, 0.1, 100);
      camera.position.set(0, 1.55, 2.4);
  
      const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
      renderer.setSize(w, h);
      renderer.setPixelRatio(window.devicePixelRatio || 1);
  
      stage.innerHTML = '';
      stage.appendChild(renderer.domElement);
  
      // lights
      const key = new THREE.DirectionalLight(0xffffff, 1.2);
      key.position.set(2, 3, 2);
      scene.add(key);
      scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  
      // load model
      const loader = new THREE.GLTFLoader();
      let gltf;
      try {
        gltf = await new Promise((resolve, reject) => {
          loader.load('/assets/coach.glb', resolve, undefined, reject);
        });
      } catch (e) {
        console.error('GLB load failed:', e);
        status.textContent = 'Avatar failed to load. Check /assets/coach.glb (404?).';
        return;
      }
  
      scene.add(gltf.scene);
  
      let meshWithMorphs = null;
      gltf.scene.traverse(obj => {
        if (obj.isMesh && obj.morphTargetInfluences && obj.morphTargetDictionary) {
          meshWithMorphs = obj;
        }
      });
  
      let morphIndex = null;
      if (meshWithMorphs) morphIndex = findMouthMorph(meshWithMorphs);
  
      if (!meshWithMorphs || morphIndex === null) {
        console.warn('Avatar loaded, but no mouth morph found (jawOpen/mouthOpen/viseme_aa). Mouth won’t animate.');
      }
  
      avatar.renderer = renderer;
      avatar.scene = scene;
      avatar.camera = camera;
      avatar.meshWithMorphs = meshWithMorphs;
      avatar.morphIndex = morphIndex;
  
      function animate(){
        requestAnimationFrame(animate);
  
        // mouth driven by analyser RMS
        if (avatar.meshWithMorphs && avatar.morphIndex !== null && avatar.analyser && avatar.dataArray) {
          avatar.analyser.getByteTimeDomainData(avatar.dataArray);
          let sum = 0;
          for (let i = 0; i < avatar.dataArray.length; i++) {
            const v = (avatar.dataArray[i] - 128) / 128;
            sum += v*v;
          }
          const rms = Math.sqrt(sum / avatar.dataArray.length);
          avatar.meshWithMorphs.morphTargetInfluences[avatar.morphIndex] = Math.min(1, rms * 4.0);
        }
  
        renderer.render(scene, camera);
      }
      animate();
  
      window.addEventListener('resize', () => {
        const ww = stage.clientWidth || 420;
        const hh = stage.clientHeight || 420;
        camera.aspect = ww / hh;
        camera.updateProjectionMatrix();
        renderer.setSize(ww, hh);
      });
  
      status.textContent = 'Avatar loaded ✅';
    }
  
    function attachLipSyncToAudio(audioEl) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext || !audioEl) return;
  
      if (!avatar.audioCtx) avatar.audioCtx = new AudioContext();
      const ctx = avatar.audioCtx;
  
      try { if (avatar.mediaSource) avatar.mediaSource.disconnect(); } catch {}
  
      const source = ctx.createMediaElementSource(audioEl);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
  
      source.connect(analyser);
      analyser.connect(ctx.destination);
  
      avatar.mediaSource = source;
      avatar.analyser = analyser;
      avatar.dataArray = new Uint8Array(analyser.fftSize);
    }
  
    /* =========================
       Realistic TTS (robust)
    ========================= */
    async function speakWithServerTTS(text) {
      status.textContent = 'Interviewer speaking...';
  
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          quality: 'hd',
          voice: (cfg.gender === 'female') ? 'marin' : 'cedar',
          response_format: 'mp3',
          instructions: 'Sound like a real interviewer. Natural pacing and warm tone.'
        })
      });
  
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        console.error('TTS error:', msg);
        status.textContent = 'TTS failed (check server logs).';
        return;
      }
  
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('audio')) {
        const msg = await res.text().catch(() => '');
        console.error('TTS returned non-audio:', ct, msg);
        status.textContent = 'TTS returned non-audio (check server).';
        return;
      }
  
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
  
      audio.onplay = async () => {
        setSpeaking(true);
        if (avatar.audioCtx && avatar.audioCtx.state === 'suspended') {
          try { await avatar.audioCtx.resume(); } catch {}
        }
      };
      audio.onended = () => { setSpeaking(false); URL.revokeObjectURL(url); };
      audio.onerror = () => { setSpeaking(false); URL.revokeObjectURL(url); };
  
      attachLipSyncToAudio(audio);
  
      try {
        await audio.play();
      } catch (e) {
        console.error('Audio play blocked:', e);
        status.textContent = 'Audio blocked by browser. Click the page once and try again.';
      }
    }
  
    /* =========================
       Speech Recognition
    ========================= */
    function startSTT(){
      const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Rec) {
        status.textContent = 'Speech recognition not supported. Type your answer.';
        return Promise.resolve((transcriptEl.value || '').trim());
      }
  
      transcriptEl.value = '';
      status.textContent = 'Listening... speak your answer.';
      stopBtn.disabled = false;
  
      return new Promise(resolve => {
        recognition = new Rec();
        recognition.lang = 'en-US';
        recognition.interimResults = true;
        recognition.continuous = false;
  
        let finalText = '';
  
        recognition.onresult = (event) => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const t = event.results[i][0].transcript;
            if (event.results[i].isFinal) finalText += t;
            else interim += t;
          }
          transcriptEl.value = (finalText + interim).trim();
        };
  
        recognition.onend = () => {
          stopBtn.disabled = true;
          recognition = null;
          resolve((finalText || transcriptEl.value || '').trim());
        };
  
        recognition.onerror = () => {
          stopBtn.disabled = true;
          recognition = null;
          resolve((finalText || transcriptEl.value || '').trim());
        };
  
        recognition.start();
      });
    }
  
    function stopSTT(){
      if (recognition) {
        recognition.stop();
        recognition = null;
        stopBtn.disabled = true;
        status.textContent = 'Stopped listening.';
      }
    }
  
    /* =========================
       API calls
    ========================= */
    async function fetchNextQuestion(){
      const res = await fetch('/api/interview/question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: cfg.type || 'Behavioral',
          level: cfg.level || 'Intern',
          askedIds
        })
      });
      const data = await res.json();
      if (data.done) return null;
      return data.question;
    }
  
    function escapeHtml(str){
      return String(str || '')
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'","&#039;");
    }
  
    function renderFeedbackCard(q, answer, fb){
      const div = document.createElement('div');
      div.className = 'feedback-card';
      div.innerHTML = `
        <h4>${escapeHtml(q.text)} <span class="badge">Score: ${Number(fb.score || 0)}</span></h4>
        <p><strong>You said:</strong> ${escapeHtml(answer)}</p>
        <p><strong>Say this instead:</strong></p>
        <p>${escapeHtml(fb.improvedAnswer || '')}</p>
      `;
      feedbackEl.prepend(div);
    }
  
    async function runRound(){
      if (round >= (cfg.rounds || 5)) {
        status.textContent = 'Session complete.';
        nextBtn.disabled = true;
        startBtn.disabled = false;
        startBtn.textContent = 'Start Again';
        return;
      }
  
      nextBtn.disabled = true;
      transcriptEl.value = '';
  
      currentQuestion = await fetchNextQuestion();
      if (!currentQuestion) {
        status.textContent = 'No more questions available.';
        startBtn.disabled = false;
        return;
      }
  
      askedIds.push(currentQuestion.id);
      round += 1;
  
      questionEl.textContent = `Q${round}/${cfg.rounds || 5}: ${currentQuestion.text}`;
  
      await speakWithServerTTS(currentQuestion.text);
  
      const answer = await startSTT();
      const safeAnswer = answer.length ? answer : 'I was unable to answer clearly.';
  
      status.textContent = 'Generating feedback...';
  
      const fbRes = await fetch('/api/interview/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: {
            text: currentQuestion.text,
            type: currentQuestion.type,
            level: currentQuestion.level
          },
          answer: safeAnswer,
          coachStyle: cfg.coachStyle || 'InternBuddy Coach'
        })
      });
  
      const fbData = await fbRes.json();
      if (!fbRes.ok) {
        console.error('Feedback error:', fbData);
        status.textContent = 'Feedback failed (check server logs).';
        nextBtn.disabled = false;
        return;
      }
  
      renderFeedbackCard(currentQuestion, safeAnswer, fbData.feedback);
      status.textContent = 'Done. Click Next Question.';
      nextBtn.disabled = false;
    }
  
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      feedbackEl.innerHTML = '';
      askedIds.length = 0;
      round = 0;
  
      // create/resume audio context inside click (autoplay policy)
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext && !avatar.audioCtx) avatar.audioCtx = new AudioContext();
      if (avatar.audioCtx && avatar.audioCtx.state === 'suspended') {
        try { await avatar.audioCtx.resume(); } catch {}
      }
  
      await runRound();
    });
  
    nextBtn.addEventListener('click', runRound);
    stopBtn.addEventListener('click', stopSTT);
  
    (async function init(){
      await initCamera();
      await initAvatar();
      status.textContent = 'Ready. Click Start Interview.';
      nextBtn.disabled = false;
    })();
  })();
  