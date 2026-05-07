(function internBuddyInterview(){
  /* =========================================================
     SHARED HELPERS
  ========================================================= */

  function safeJsonParse(value, fallback){
    try{
      return JSON.parse(value);
    }catch(error){
      return fallback;
    }
  }

  function escapeHtml(str){
    return String(str || "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function getSelectedGender(){
    const active = document.querySelector(".seg.on[data-gender]");
    return active ? active.dataset.gender : "male";
  }

  function setStatus(message){
    const status = document.getElementById("status");
    if(status){
      status.textContent = message;
    }
  }

  function go(file){
    const base = new URL(".", window.location.href);
    window.location.href = new URL(file, base).href;
  }

  /* =========================================================
     PAGE 1: INTERVIEW SETUP PAGE
     Works with interview-prep.html
  ========================================================= */

  function initSetupPage(){
    const startBtn = document.getElementById("startBtn");
    const healthBtn = document.getElementById("healthBtn");

    const coachStyle = document.getElementById("coachStyle");
    const level = document.getElementById("level");
    const type = document.getElementById("type");
    const role = document.getElementById("role");
    const rounds = document.getElementById("rounds");

    const isSetupPage =
      startBtn &&
      coachStyle &&
      level &&
      type &&
      rounds &&
      !document.getElementById("question");

    if(!isSetupPage){
      return;
    }

    document.querySelectorAll(".seg[data-gender]").forEach(function(button){
      button.addEventListener("click", function(){
        document.querySelectorAll(".seg[data-gender]").forEach(btn => btn.classList.remove("on"));
        button.classList.add("on");
      });
    });

    if(healthBtn){
      healthBtn.addEventListener("click", async function(){
        healthBtn.disabled = true;
        healthBtn.textContent = "Testing...";
        setStatus("Testing backend...");

        try{
          const res = await fetch("/api/health");
          const data = await res.json();

          if(!res.ok){
            throw new Error(data.error || "Backend failed.");
          }

          setStatus("Backend connected ✅");
        }catch(error){
          console.error(error);
          setStatus("Backend test failed. Check Vercel logs or /api/health.");
        }finally{
          healthBtn.disabled = false;
          healthBtn.textContent = "Test backend";
        }
      });
    }

    startBtn.addEventListener("click", function(){
      const config = {
        gender: getSelectedGender(),
        coachStyle: coachStyle.value || "Supportive Coach",
        level: level.value || "Intern",
        type: type.value || "Behavioral",
        role: role ? role.value.trim() : "",
        rounds: Number(rounds.value || 5)
      };

      sessionStorage.setItem("interviewConfig", JSON.stringify(config));

      setStatus("Starting mock interview...");
      startBtn.disabled = true;
      startBtn.textContent = "Opening interview...";

      setTimeout(function(){
        go("mock-interview.html");
      }, 350);
    });

    setStatus("Ready.");
  }

  /* =========================================================
     PAGE 2: MOCK INTERVIEW PAGE
     Works with mock-interview.html
  ========================================================= */

  function initMockInterviewPage(){
    const startBtn = document.getElementById("startBtn");
    const nextBtn = document.getElementById("nextBtn");
    const stopBtn = document.getElementById("stopBtn");
    const status = document.getElementById("status");
    const questionEl = document.getElementById("question");
    const feedbackEl = document.getElementById("feedback");
    const transcriptEl = document.getElementById("transcript");
    const voiceBar = document.getElementById("voiceBar");
    const webcam = document.getElementById("webcam");

    const isMockPage =
      startBtn &&
      nextBtn &&
      stopBtn &&
      status &&
      questionEl &&
      feedbackEl &&
      transcriptEl;

    if(!isMockPage){
      return;
    }

    const cfg = {
      gender: "male",
      coachStyle: "Supportive Coach",
      level: "Intern",
      type: "Behavioral",
      role: "",
      rounds: 5,
      ...safeJsonParse(sessionStorage.getItem("interviewConfig") || "{}", {})
    };

    const askedIds = [];
    let currentQuestion = null;
    let round = 0;
    let recognition = null;
    let cameraStarted = false;
    let avatarStarted = false;

    const fallbackQuestions = [
      {
        id: "fallback_1",
        text: "Tell me about yourself and why you are interested in this role.",
        type: "Behavioral",
        level: "Intern"
      },
      {
        id: "fallback_2",
        text: "Describe a time you solved a difficult problem.",
        type: "Behavioral",
        level: "Intern"
      },
      {
        id: "fallback_3",
        text: "Why do you want to work in this field?",
        type: "Motivation",
        level: "Intern"
      },
      {
        id: "fallback_4",
        text: "Tell me about a time you worked in a team.",
        type: "Communication",
        level: "Intern"
      },
      {
        id: "fallback_5",
        text: "What are your biggest strengths for this role?",
        type: "Behavioral",
        level: "Intern"
      }
    ];

    function setSpeaking(on){
      if(!voiceBar) return;
      voiceBar.classList.toggle("quiet", !on);
    }

    function setMockStatus(message){
      status.textContent = message;
    }

    function setButtons(state){
      if(state === "ready"){
        startBtn.disabled = false;
        nextBtn.disabled = true;
        stopBtn.disabled = true;
      }

      if(state === "running"){
        startBtn.disabled = true;
        nextBtn.disabled = true;
        stopBtn.disabled = true;
      }

      if(state === "listening"){
        startBtn.disabled = true;
        nextBtn.disabled = true;
        stopBtn.disabled = false;
      }

      if(state === "next"){
        startBtn.disabled = true;
        nextBtn.disabled = false;
        stopBtn.disabled = true;
      }

      if(state === "complete"){
        startBtn.disabled = false;
        nextBtn.disabled = true;
        stopBtn.disabled = true;
        startBtn.textContent = "Start Again";
      }
    }

    /* =====================================================
       CAMERA
    ===================================================== */

    async function initCamera(){
      if(cameraStarted) return;
      cameraStarted = true;

      if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
        setMockStatus("Camera not supported. Continuing without camera.");
        return;
      }

      try{
        const stream = await navigator.mediaDevices.getUserMedia({
          video:true,
          audio:false
        });

        if(webcam){
          webcam.srcObject = stream;
          webcam.muted = true;
          webcam.volume = 0;
        }
      }catch(error){
        console.warn("Camera error:", error);
        setMockStatus("Camera permission denied. Continuing without camera.");
      }
    }

    /* =====================================================
       AVATAR / THREE.JS
    ===================================================== */

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

    function findMouthMorph(mesh){
      const candidates = [
        "jawOpen",
        "JawOpen",
        "mouthOpen",
        "MouthOpen",
        "viseme_aa",
        "viseme_AA",
        "viseme_O",
        "viseme_E"
      ];

      const dict = mesh.morphTargetDictionary || {};

      for(const name of candidates){
        if(dict[name] !== undefined){
          return dict[name];
        }
      }

      return null;
    }

    async function loadGLB(loader, paths){
      for(const modelPath of paths){
        try{
          const gltf = await new Promise((resolve, reject) => {
            loader.load(modelPath, resolve, undefined, reject);
          });

          return gltf;
        }catch(error){
          console.warn("Model load failed:", modelPath, error);
        }
      }

      return null;
    }

    async function initAvatar(){
      if(avatarStarted) return;
      avatarStarted = true;

      const stage = document.getElementById("avatarStage");

      if(!stage){
        return;
      }

      if(!window.THREE || !THREE.GLTFLoader){
        console.warn("Three.js or GLTFLoader not loaded.");
        setMockStatus("Avatar libraries not loaded. Continuing without avatar.");
        return;
      }

      const width = stage.clientWidth || 420;
      const height = stage.clientHeight || 420;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100);
      camera.position.set(0, 1.55, 2.4);

      const renderer = new THREE.WebGLRenderer({
        antialias:true,
        alpha:true
      });

      renderer.setSize(width, height);
      renderer.setPixelRatio(window.devicePixelRatio || 1);

      stage.innerHTML = "";
      stage.appendChild(renderer.domElement);

      const key = new THREE.DirectionalLight(0xffffff, 1.2);
      key.position.set(2, 3, 2);
      scene.add(key);
      scene.add(new THREE.AmbientLight(0xffffff, 0.7));

      const loader = new THREE.GLTFLoader();

      const gltf = await loadGLB(loader, [
        "/assets/coach.glb",
        "/coach.glb",
        "coach.glb",
        "assets/coach.glb"
      ]);

      if(!gltf){
        setMockStatus("Avatar model not found. Continuing without avatar.");
        return;
      }

      scene.add(gltf.scene);

      let meshWithMorphs = null;

      gltf.scene.traverse(obj => {
        if(obj.isMesh && obj.morphTargetInfluences && obj.morphTargetDictionary){
          meshWithMorphs = obj;
        }
      });

      let morphIndex = null;

      if(meshWithMorphs){
        morphIndex = findMouthMorph(meshWithMorphs);
      }

      if(!meshWithMorphs || morphIndex === null){
        console.warn("Avatar loaded but no mouth morph found.");
      }

      avatar.renderer = renderer;
      avatar.scene = scene;
      avatar.camera = camera;
      avatar.meshWithMorphs = meshWithMorphs;
      avatar.morphIndex = morphIndex;

      function animate(){
        requestAnimationFrame(animate);

        if(
          avatar.meshWithMorphs &&
          avatar.morphIndex !== null &&
          avatar.analyser &&
          avatar.dataArray
        ){
          avatar.analyser.getByteTimeDomainData(avatar.dataArray);

          let sum = 0;

          for(let i = 0; i < avatar.dataArray.length; i++){
            const v = (avatar.dataArray[i] - 128) / 128;
            sum += v * v;
          }

          const rms = Math.sqrt(sum / avatar.dataArray.length);
          avatar.meshWithMorphs.morphTargetInfluences[avatar.morphIndex] = Math.min(1, rms * 4.2);
        }

        renderer.render(scene, camera);
      }

      animate();

      window.addEventListener("resize", function(){
        const newWidth = stage.clientWidth || 420;
        const newHeight = stage.clientHeight || 420;

        camera.aspect = newWidth / newHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(newWidth, newHeight);
      });
    }

    function attachLipSyncToAudio(audioEl){
      const AudioContext = window.AudioContext || window.webkitAudioContext;

      if(!AudioContext || !audioEl){
        return;
      }

      if(!avatar.audioCtx){
        avatar.audioCtx = new AudioContext();
      }

      const ctx = avatar.audioCtx;

      try{
        if(avatar.mediaSource){
          avatar.mediaSource.disconnect();
        }
      }catch(error){}

      try{
        const source = ctx.createMediaElementSource(audioEl);
        const analyser = ctx.createAnalyser();

        analyser.fftSize = 2048;

        source.connect(analyser);
        analyser.connect(ctx.destination);

        avatar.mediaSource = source;
        avatar.analyser = analyser;
        avatar.dataArray = new Uint8Array(analyser.fftSize);
      }catch(error){
        console.warn("Lip sync attach failed:", error);
      }
    }

    /* =====================================================
       TTS
    ===================================================== */

    function browserSpeak(text){
      return new Promise(resolve => {
        if(!window.speechSynthesis){
          resolve();
          return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-GB";
        utterance.rate = 0.95;
        utterance.pitch = cfg.gender === "female" ? 1.08 : 0.92;

        utterance.onstart = function(){
          setSpeaking(true);
        };

        utterance.onend = function(){
          setSpeaking(false);
          resolve();
        };

        utterance.onerror = function(){
          setSpeaking(false);
          resolve();
        };

        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      });
    }

    async function speakWithServerTTS(text){
      setMockStatus("Interviewer speaking...");

      try{
        const res = await fetch("/api/tts", {
          method:"POST",
          headers:{
            "Content-Type":"application/json"
          },
          body:JSON.stringify({
            text:text,
            quality:"standard",
            voice: cfg.gender === "female" ? "nova" : "onyx",
            response_format:"mp3",
            instructions:"Speak like a realistic professional interviewer with natural pacing and a warm tone."
          })
        });

        if(!res.ok){
          const msg = await res.text().catch(() => "");
          console.error("TTS error:", msg);
          throw new Error("TTS failed.");
        }

        const contentType = String(res.headers.get("content-type") || "").toLowerCase();

        if(!contentType.includes("audio")){
          const msg = await res.text().catch(() => "");
          console.error("TTS returned non-audio:", contentType, msg);
          throw new Error("TTS returned non-audio.");
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        attachLipSyncToAudio(audio);

        return await new Promise(resolve => {
          audio.onplay = async function(){
            setSpeaking(true);

            if(avatar.audioCtx && avatar.audioCtx.state === "suspended"){
              try{
                await avatar.audioCtx.resume();
              }catch(error){}
            }
          };

          audio.onended = function(){
            setSpeaking(false);
            URL.revokeObjectURL(url);
            resolve();
          };

          audio.onerror = function(){
            setSpeaking(false);
            URL.revokeObjectURL(url);
            resolve();
          };

          audio.play().catch(error => {
            console.error("Audio play blocked:", error);
            setSpeaking(false);
            URL.revokeObjectURL(url);
            browserSpeak(text).then(resolve);
          });
        });
      }catch(error){
        console.warn("Using browser speech fallback:", error);
        await browserSpeak(text);
      }
    }

    /* =====================================================
       SPEECH RECOGNITION
    ===================================================== */

    function startSTT(){
      const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;

      if(!Rec){
        setMockStatus("Speech recognition not supported. Type your answer, then click Next Question.");
        setButtons("next");
        return Promise.resolve((transcriptEl.value || "").trim());
      }

      transcriptEl.value = "";
      setMockStatus("Listening... speak your answer.");
      setButtons("listening");

      return new Promise(resolve => {
        recognition = new Rec();
        recognition.lang = "en-GB";
        recognition.interimResults = true;
        recognition.continuous = false;

        let finalText = "";
        let resolved = false;

        const timeout = setTimeout(function(){
          if(recognition){
            try{
              recognition.stop();
            }catch(error){}
          }
        }, 25000);

        function finish(text){
          if(resolved) return;

          resolved = true;
          clearTimeout(timeout);
          stopBtn.disabled = true;
          recognition = null;

          resolve(String(text || transcriptEl.value || "").trim());
        }

        recognition.onresult = function(event){
          let interim = "";

          for(let i = event.resultIndex; i < event.results.length; i++){
            const transcript = event.results[i][0].transcript;

            if(event.results[i].isFinal){
              finalText += transcript + " ";
            }else{
              interim += transcript;
            }
          }

          transcriptEl.value = (finalText + interim).trim();
        };

        recognition.onend = function(){
          finish(finalText || transcriptEl.value);
        };

        recognition.onerror = function(event){
          console.warn("Speech recognition error:", event);
          finish(finalText || transcriptEl.value);
        };

        try{
          recognition.start();
        }catch(error){
          console.warn("Speech recognition start failed:", error);
          finish(transcriptEl.value);
        }
      });
    }

    function stopSTT(){
      if(recognition){
        try{
          recognition.stop();
        }catch(error){}

        recognition = null;
        stopBtn.disabled = true;
        setMockStatus("Stopped listening.");
      }
    }

    /* =====================================================
       API CALLS
    ===================================================== */

    async function fetchNextQuestion(){
      try{
        const res = await fetch("/api/interview/question", {
          method:"POST",
          headers:{
            "Content-Type":"application/json"
          },
          body:JSON.stringify({
            type: cfg.type || "Behavioral",
            level: cfg.level || "Intern",
            askedIds: askedIds
          })
        });

        const data = await res.json();

        if(!res.ok){
          throw new Error(data.error || "Question API failed.");
        }

        if(data.done){
          return null;
        }

        return data.question;
      }catch(error){
        console.warn("Using fallback question:", error);

        const fallback = fallbackQuestions.find(q => !askedIds.includes(q.id));

        return fallback || null;
      }
    }

    function buildFallbackFeedback(answer){
      const wordCount = String(answer || "").split(/\s+/).filter(Boolean).length;

      let score = 55;

      if(wordCount > 30) score += 15;
      if(/\b(i|my|me)\b/i.test(answer)) score += 5;
      if(/\b(result|impact|learned|improved|achieved|delivered)\b/i.test(answer)) score += 10;

      score = Math.min(score, 85);

      return {
        score: score,
        strengths: [
          "You gave an answer that can be developed further.",
          "You attempted to respond directly to the question."
        ],
        mistakes: [
          "Add a clearer structure using situation, task, action and result.",
          "Include a stronger outcome or reflection."
        ],
        improvedAnswer:
          "A stronger answer would briefly explain the situation, what your responsibility was, the actions you personally took, and the result. Keep it focused and specific, then finish with what you learned or how it prepared you for the role.",
        tips: [
          "Use the STAR structure.",
          "Mention your personal contribution.",
          "End with a result or lesson learned."
        ]
      };
    }

    async function fetchFeedback(question, answer){
      try{
        const res = await fetch("/api/interview/feedback", {
          method:"POST",
          headers:{
            "Content-Type":"application/json"
          },
          body:JSON.stringify({
            question:{
              text: question.text,
              type: question.type,
              level: question.level
            },
            answer: answer,
            coachStyle: cfg.coachStyle || "InternBuddy Coach"
          })
        });

        const data = await res.json();

        if(!res.ok){
          throw new Error(data.error || "Feedback API failed.");
        }

        return data.feedback;
      }catch(error){
        console.warn("Using fallback feedback:", error);
        return buildFallbackFeedback(answer);
      }
    }

    /* =====================================================
       RENDERING
    ===================================================== */

    function renderFeedbackCard(q, answer, fb){
      const div = document.createElement("div");
      div.className = "feedback-card";

      const strengths = Array.isArray(fb.strengths) ? fb.strengths : [];
      const mistakes = Array.isArray(fb.mistakes) ? fb.mistakes : [];
      const tips = Array.isArray(fb.tips) ? fb.tips : [];

      div.innerHTML = `
        <h4>
          ${escapeHtml(q.text)}
          <span class="badge">Score: ${Number(fb.score || 0)}</span>
        </h4>

        <p><strong>You said:</strong> ${escapeHtml(answer || "No clear answer captured.")}</p>

        ${strengths.length ? `
          <p><strong>Strengths:</strong></p>
          <ul>${strengths.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        ` : ""}

        ${mistakes.length ? `
          <p><strong>Improve:</strong></p>
          <ul>${mistakes.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        ` : ""}

        <p><strong>Say this instead:</strong></p>
        <p>${escapeHtml(fb.improvedAnswer || "")}</p>

        ${tips.length ? `
          <p><strong>Tips:</strong></p>
          <ul>${tips.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        ` : ""}
      `;

      feedbackEl.prepend(div);
    }

    /* =====================================================
       MAIN INTERVIEW LOOP
    ===================================================== */

    async function runRound(){
      if(round >= Number(cfg.rounds || 5)){
        questionEl.textContent = "Interview complete.";
        setMockStatus("Session complete. Review your feedback below.");
        setButtons("complete");
        return;
      }

      setButtons("running");
      transcriptEl.value = "";

      currentQuestion = await fetchNextQuestion();

      if(!currentQuestion){
        questionEl.textContent = "No more questions available.";
        setMockStatus("No more questions available.");
        setButtons("complete");
        return;
      }

      askedIds.push(currentQuestion.id);
      round += 1;

      questionEl.textContent = `Q${round}/${Number(cfg.rounds || 5)}: ${currentQuestion.text}`;

      await speakWithServerTTS(currentQuestion.text);

      const answer = await startSTT();
      const safeAnswer = answer.length ? answer : "I was unable to answer clearly.";

      setMockStatus("Generating feedback...");
      setButtons("running");

      const feedback = await fetchFeedback(currentQuestion, safeAnswer);

      renderFeedbackCard(currentQuestion, safeAnswer, feedback);

      setMockStatus("Done. Click Next Question.");
      setButtons("next");
    }

    startBtn.addEventListener("click", async function(){
      feedbackEl.innerHTML = "";
      askedIds.length = 0;
      round = 0;
      startBtn.textContent = "Start Interview";

      const AudioContext = window.AudioContext || window.webkitAudioContext;

      if(AudioContext && !avatar.audioCtx){
        avatar.audioCtx = new AudioContext();
      }

      if(avatar.audioCtx && avatar.audioCtx.state === "suspended"){
        try{
          await avatar.audioCtx.resume();
        }catch(error){}
      }

      await initCamera();
      await initAvatar();
      await runRound();
    });

    nextBtn.addEventListener("click", runRound);
    stopBtn.addEventListener("click", stopSTT);

    setButtons("ready");
    setMockStatus("Ready. Click Start Interview.");
  }

  /* =========================================================
     INIT BOTH MODES
  ========================================================= */

  initSetupPage();
  initMockInterviewPage();
})();