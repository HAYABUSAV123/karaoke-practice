// ============================================================
// カラオケ練習ツール v3
// ・左右の音源が別々の再生位置を持つ（連動ON/OFF）
// ・波形をタップ/ドラッグして位置を動かす
// ・ループ設定を開いたときだけ、ピン付きループが使える
// ============================================================
 
// iPhoneの消音スイッチがONでも鳴らす
if (navigator.audioSession) navigator.audioSession.type = "playback";
 
const AudioCtx = window.AudioContext || window.webkitAudioContext;
const audioContext = new AudioCtx();
 
// 左耳・右耳に分けて出力するための合流ノード
const merger = audioContext.createChannelMerger(2);
merger.connect(audioContext.destination);
 
// 音源1つ分の状態をまとめて持つ
function createTrack(outputIndex, canvasId) {
    const gain = audioContext.createGain();
    gain.channelCount = 1;
    gain.channelCountMode = "explicit";
    gain.channelInterpretation = "speakers";
    gain.connect(merger, 0, outputIndex);
    return {
        name: outputIndex === 0 ? "左" : "右",
        buffer: null,
        peaks: null,
        gain: gain,
        canvas: document.getElementById(canvasId),
        offset: 0,            // 停止中の再生位置（秒）
        volume: 1,
        muted: false,
        pinStart: null,       // ループ開始ピン（なし=null）
        pinEnd: null,         // ループ終了ピン（なし=null）
        range: null           // ループ再生中の区間 {s, e}
    };
}
 
const left = createTrack(0, "leftWave");
const right = createTrack(1, "rightWave");
const tracks = [left, right];
 
 
// ===== HTMLから部品を取得 =====
const $ = id => document.getElementById(id);
const leftFile = $("leftFile"), rightFile = $("rightFile");
const playButton = $("playButton"), stopButton = $("stopButton"), syncButton = $("syncButton");
const backButton = $("backButton"), forwardButton = $("forwardButton");
const timeDisplay = $("timeDisplay");
const linkButton = $("linkButton");
const leftMuteButton = $("leftMuteButton"), rightMuteButton = $("rightMuteButton");
const loopSettingsButton = $("loopSettingsButton"), loopControls = $("loopControls");
const loopPlayButton = $("loopPlayButton"), pinInfo = $("pinInfo");
const settingsButton = $("settingsButton");
const skipTime = $("skipTime"), volumeStep = $("volumeStep"), playbackRate = $("playbackRate");
const leftVolume = $("leftVolume"), rightVolume = $("rightVolume");
 
 
// ===== 状態 =====
let isPlaying = false;
let loopMode = false;      // 周回ループ中か
let loopOpen = false;      // ループ設定を開いているか
let linked = true;         // 連動ON（片方を動かすともう片方も同じ分だけ動く）
let sources = [];          // 今鳴らしている音のノード
let startedAt = 0;         // 通常再生を始めた時刻
let activeRate = 1;        // 再生開始時の速度
let cycleStart = 0;        // ループの今の周の開始時刻
let nextCycleAt = 0;       // ループの次の周の開始時刻
let cycleLen = 0;          // ループ1周の長さ（秒、長い方に合わせる）
let cycleScheduled = false;
 
 
// ===== 基本の関数 =====
const dur = t => t.buffer ? t.buffer.duration : 0;
const totalDuration = () => Math.max(dur(left), dur(right));
const clampTime = (t, sec) => Math.min(Math.max(0, sec), dur(t));
 
function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}
 
// その音源の今の再生位置（秒）
function getPos(t) {
    if (!isPlaying || !t.buffer) return t.offset;
    const now = audioContext.currentTime;
    if (loopMode) {
        const r = t.range;
        return r.s + Math.min(Math.max(0, now - cycleStart) * activeRate, r.e - r.s);
    }
    return Math.min(dur(t), t.offset + Math.max(0, now - startedAt) * activeRate);
}
 
// 再生中の位置を offset に保存する（鳴らし直す前に呼ぶ）
function capture() {
    if (isPlaying) for (const t of tracks) t.offset = getPos(t);
}
 
function stopSources() {
    for (const s of sources) {
        s.onended = null;
        try { s.stop(); } catch (e) { /* 停止済みなら無視 */ }
        s.disconnect();
    }
    sources = [];
}
 
function playBuffer(t, when, from, length) {
    const src = audioContext.createBufferSource();
    src.buffer = t.buffer;
    src.playbackRate.value = activeRate;
    src.connect(t.gain);
    if (length === undefined) src.start(when, from);
    else src.start(when, from, length);
    src.onended = function() { sources = sources.filter(s => s !== src); };
    sources.push(src);
}
 
// 通常再生：左右それぞれの offset から、同じ時刻に鳴らし始める
function startNormal() {
    stopSources();
    activeRate = Number(playbackRate.value);
    const when = audioContext.currentTime + 0.05;
    for (const t of tracks) {
        if (t.buffer && t.offset < dur(t)) playBuffer(t, when, t.offset);
    }
    startedAt = when;
    isPlaying = true;
    loopMode = false;
}
 
// ループ再生：各音源の [開始, 終了] を、左右同時に始めて繰り返す
function startLoop() {
    stopSources();
    activeRate = Number(playbackRate.value);
    let maxLen = 0;
    for (const t of tracks) {
        if (!t.buffer) continue;
        t.range = { s: t.pinStart ?? 0, e: t.pinEnd ?? dur(t) };
        maxLen = Math.max(maxLen, t.range.e - t.range.s);
    }
    cycleLen = maxLen / activeRate;   // 長い方が終わるまで待つ
    const when = audioContext.currentTime + 0.05;
    scheduleCycle(when);
    cycleStart = when;
    nextCycleAt = when + cycleLen;
    cycleScheduled = false;
    isPlaying = true;
    loopMode = true;
}
 
function scheduleCycle(when) {
    for (const t of tracks) {
        if (t.buffer) playBuffer(t, when, t.range.s, t.range.e - t.range.s);
    }
}
 
// 次の周を、少し前もって予約する
function tickLoop() {
    if (!loopMode || !isPlaying) return;
    const now = audioContext.currentTime;
    if (now >= nextCycleAt) {
        cycleStart = nextCycleAt;
        nextCycleAt += cycleLen;
        cycleScheduled = false;
    }
    if (!cycleScheduled && now >= nextCycleAt - 0.3) {
        scheduleCycle(nextCycleAt);
        cycleScheduled = true;
    }
}
 
function pauseAll() {
    capture();
    stopSources();
    isPlaying = false;
    loopMode = false;
    updateButtons();
}
 
function stopAll() {
    stopSources();
    isPlaying = false;
    loopMode = false;
    for (const t of tracks) t.offset = 0;
    updateButtons();
}
 
function updateButtons() {
    playButton.textContent = (isPlaying && !loopMode) ? "⏸ 一時停止" : "▶ 再生";
    loopPlayButton.textContent = (isPlaying && loopMode) ? "■ 再生停止！" : "▶ 再生開始！";
    linkButton.textContent = linked ? "連動：ON" : "連動：OFF";
    for (const t of tracks) {
        const b = t === left ? leftMuteButton : rightMuteButton;
        b.textContent = t.muted ? `🔇 ${t.name}：ミュート中` : `🔊 ${t.name}：音あり`;
    }
}
 
 
// ===== 再生ボタン・ループ再生ボタン =====
// useLoop: false=通常再生、true=ループ設定の再生ボタン
async function togglePlay(useLoop) {
    if (isPlaying && useLoop === loopMode) {
        pauseAll();
        return;
    }
    if (totalDuration() === 0) {
        alert("先に音源を選択してください");
        return;
    }
 
    const hasEnd = tracks.some(t => t.pinEnd !== null);
    if (useLoop && hasEnd) {
        for (const t of tracks) {
            if (t.buffer && (t.pinEnd ?? dur(t)) - (t.pinStart ?? 0) < 0.5) {
                alert(`${t.name}のループは、終了を開始より0.5秒以上後にしてください`);
                return;
            }
        }
    }
 
    await audioContext.resume();   // iPhoneではタップ操作の中で必要
    if (isPlaying) pauseAll();     // 別のモードから切り替えるとき
 
    if (useLoop && !hasEnd) {
        // 終了ピンがなければ、開始ピンの位置からそのまま再生
        for (const t of tracks) if (t.pinStart !== null) t.offset = t.pinStart;
        useLoop = false;
    }
    if (useLoop) startLoop();
    else startNormal();
    updateButtons();
}
 
playButton.addEventListener("click", () => togglePlay(false));
loopPlayButton.addEventListener("click", () => togglePlay(true));
stopButton.addEventListener("click", stopAll);
 
 
// ===== 戻る・進む・強制同期 =====
function skip(sign) {
    if (loopMode) return;
    const wasPlaying = isPlaying;
    capture();
    const d = sign * Number(skipTime.value);
    for (const t of tracks) t.offset = clampTime(t, t.offset + d);
    if (wasPlaying) startNormal();
}
 
backButton.addEventListener("click", () => skip(-1));
forwardButton.addEventListener("click", () => skip(1));
 
// 強制同期：右の位置を左の位置に合わせる
syncButton.addEventListener("click", function() {
    if (loopMode || !left.buffer || !right.buffer) return;
    const wasPlaying = isPlaying;
    capture();
    right.offset = clampTime(right, left.offset);
    if (wasPlaying) startNormal();
});
 
function updateSkipButtonText() {
    backButton.textContent = `↩ ${skipTime.value}秒戻る`;
    forwardButton.textContent = `↪ ${skipTime.value}秒進む`;
}
 
 
// ===== 連動・ミュート =====
linkButton.addEventListener("click", function() {
    linked = !linked;
    updateButtons();
});
 
function applyGain(t) {
    t.gain.gain.value = t.muted ? 0 : t.volume;
}
 
leftMuteButton.addEventListener("click", function() {
    left.muted = !left.muted;
    applyGain(left);
    updateButtons();
});
 
rightMuteButton.addEventListener("click", function() {
    right.muted = !right.muted;
    applyGain(right);
    updateButtons();
});
 
 
// ===== 再生速度（変えると音程も変わる） =====
playbackRate.addEventListener("change", function() {
    if (isPlaying) {
        if (loopMode) {
            startLoop();
        } else {
            capture();
            startNormal();
        }
    }
    localStorage.setItem("playbackRate", playbackRate.value);
});
 
 
// ===== 波形 =====
const PEAK_BINS = 2000;
 
// 音源を2000区間に分けて、区間ごとの最大音量を求める
function computePeaks(buffer) {
    const peaks = new Float32Array(PEAK_BINS);
    const length = buffer.length;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < PEAK_BINS; i++) {
            const from = Math.floor(i * length / PEAK_BINS);
            const to = Math.floor((i + 1) * length / PEAK_BINS);
            let max = peaks[i];
            for (let j = from; j < to; j += 8) {
                const v = Math.abs(data[j]);
                if (v > max) max = v;
            }
            peaks[i] = max;
        }
    }
    let top = 0;
    for (const p of peaks) if (p > top) top = p;
    if (top > 0) for (let i = 0; i < PEAK_BINS; i++) peaks[i] /= top;
    return peaks;
}
 
function drawPin(c, sec, total, w, h, color) {
    if (sec === null) return;
    const x = sec / total * w;
    c.fillStyle = color;
    c.fillRect(x - 1, 0, 2, h);
    c.beginPath();               // 上のつまみ（▼）
    c.moveTo(x - 8, 0);
    c.lineTo(x + 8, 0);
    c.lineTo(x, 12);
    c.fill();
}
 
function drawWave(t, total) {
    const canvas = t.canvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;   // 設定画面で隠れているときは描かない
 
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
 
    if (!t.peaks || total === 0) {
        c.fillStyle = "#999";
        c.font = "14px sans-serif";
        c.textAlign = "center";
        c.fillText(`${t.name}音源を選択してください`, w / 2, h / 2 + 5);
        return;
    }
 
    // 横軸は左右共通（長い方の音源の長さ＝画面の幅）
    const waveWidth = w * dur(t) / total;
    const mid = h / 2;
    c.fillStyle = "#4a90d9";
    for (let x = 0; x < waveWidth; x++) {
        const i0 = Math.floor(x / waveWidth * PEAK_BINS);
        const i1 = Math.max(i0 + 1, Math.floor((x + 1) / waveWidth * PEAK_BINS));
        let p = 0;
        for (let i = i0; i < i1 && i < PEAK_BINS; i++) {
            if (t.peaks[i] > p) p = t.peaks[i];
        }
        const amp = Math.max(1, p * mid * 0.95);
        c.fillRect(x, mid - amp, 1, amp * 2);
    }
 
    // ループ設定を開いているときだけ、ピンと範囲を表示
    if (loopOpen) {
        if (t.pinStart !== null || t.pinEnd !== null) {
            const sx = (t.pinStart ?? 0) / total * w;
            const ex = (t.pinEnd ?? dur(t)) / total * w;
            c.fillStyle = "rgba(46,125,50,0.12)";
            c.fillRect(sx, 0, ex - sx, h);
        }
        drawPin(c, t.pinStart, total, w, h, "#2e7d32");
        drawPin(c, t.pinEnd, total, w, h, "#ef6c00");
    }
 
    // 再生位置の赤い線
    c.fillStyle = "#e53935";
    c.fillRect(getPos(t) / total * w - 1, 0, 2, h);
}
 
// 波形のタップ・ドラッグ
function setupWave(t) {
    const canvas = t.canvas;
    let drag = null;
 
    const toTime = e => {
        const r = canvas.getBoundingClientRect();
        return clampTime(t, (e.clientX - r.left) / r.width * totalDuration());
    };
 
    // 自分を time に動かす。連動ONなら、もう片方も同じ分だけ動かす
    const moveTo = time => {
        const delta = time - t.offset;
        t.offset = time;
        if (linked) {
            for (const o of tracks) {
                if (o !== t && o.buffer) o.offset = clampTime(o, o.offset + delta);
            }
        }
    };
 
    canvas.addEventListener("pointerdown", function(e) {
        if (!t.buffer) return;
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        const total = totalDuration();
 
        // ループ設定を開いているときは、近くのピンを優先してつかむ
        let key = null;
        let best = 16;
        if (loopOpen) {
            for (const k of ["pinStart", "pinEnd"]) {
                if (t[k] === null) continue;
                const d = Math.abs(t[k] / total * r.width - x);
                if (d < best) { best = d; key = k; }
            }
        }
 
        if (key) {
            drag = { key: key };
        } else {
            if (loopMode) return;   // ループ再生中は再生位置を動かさない
            drag = { key: null, wasPlaying: isPlaying };
            if (isPlaying) pauseAll();
            moveTo(toTime(e));
        }
        canvas.setPointerCapture(e.pointerId);
    });
 
    canvas.addEventListener("pointermove", function(e) {
        if (!drag) return;
        if (drag.key) t[drag.key] = toTime(e);   // 小数秒のまま動かす
        else moveTo(toTime(e));
    });
 
    const end = function() {
        if (drag && !drag.key && drag.wasPlaying) {
            startNormal();
            updateButtons();
        }
        drag = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
}
 
tracks.forEach(setupWave);
 
 
// ===== ループ設定（開いているときだけ有効） =====
loopSettingsButton.addEventListener("click", function() {
    loopOpen = !loopOpen;
 
    // 開くときも閉じるときも、ピンは白紙に戻す
    for (const t of tracks) { t.pinStart = null; t.pinEnd = null; }
 
    // ループ再生中に閉じたら、通常再生に切り替えて続ける
    if (!loopOpen && loopMode) {
        capture();
        startNormal();
        updateButtons();
    }
 
    loopControls.classList.toggle("open", loopOpen);
    updatePinInfo();
});
 
// ピンボタン：その音源の今の再生位置をピンにする
function setPin(t, key) {
    if (!t.buffer) return;
    t[key] = getPos(t);
    updatePinInfo();
}
 
$("leftPinStart").addEventListener("click", () => setPin(left, "pinStart"));
$("leftPinEnd").addEventListener("click", () => setPin(left, "pinEnd"));
$("rightPinStart").addEventListener("click", () => setPin(right, "pinStart"));
$("rightPinEnd").addEventListener("click", () => setPin(right, "pinEnd"));
 
function updatePinInfo() {
    if (!loopOpen) return;
    const f = v => v === null ? "なし" : formatTime(v);
    let text = `左　開始 ${f(left.pinStart)}　終了 ${f(left.pinEnd)}\n` +
               `右　開始 ${f(right.pinStart)}　終了 ${f(right.pinEnd)}`;
 
    if (left.buffer && right.buffer && tracks.some(t => t.pinEnd !== null)) {
        const len = t => (t.pinEnd ?? dur(t)) - (t.pinStart ?? 0);
        text += `\nループの長さの差 ${Math.abs(len(left) - len(right)).toFixed(1)}秒`;
    }
    pinInfo.textContent = text;
}
 
 
// ===== 画面の更新 =====
function updateUI() {
    // 最後まで再生したら先頭に戻して停止
    if (isPlaying && !loopMode && tracks.every(t => !t.buffer || getPos(t) >= dur(t) - 0.01)) {
        stopAll();
    }
 
    timeDisplay.textContent =
        `左 ${formatTime(getPos(left))} / ${formatTime(dur(left))}　` +
        `右 ${formatTime(getPos(right))} / ${formatTime(dur(right))}`;
 
    const total = totalDuration();
    drawWave(left, total);
    drawWave(right, total);
    updatePinInfo();
}
 
setInterval(function() {
    tickLoop();
    updateUI();
}, 50);
 
 
// ===== ファイルの読み込み =====
function decodeAudio(arrayBuffer) {
    return new Promise(function(resolve, reject) {
        const p = audioContext.decodeAudioData(arrayBuffer, resolve, reject);
        if (p && p.catch) p.catch(reject);
    });
}
 
async function loadFile(input, t) {
    const file = input.files[0];
    if (!file) return;
 
    stopAll();
    t.pinStart = null;
    t.pinEnd = null;
    console.log(`${t.name}音源:`, file.name, file.type, file.size);
    timeDisplay.textContent = `${t.name}音源を読み込み中…`;
 
    try {
        const arrayBuffer = await file.arrayBuffer();
        t.buffer = await decodeAudio(arrayBuffer);
        t.peaks = computePeaks(t.buffer);
        console.log(`${t.name}音源の長さ:`, t.buffer.duration);
    } catch (e) {
        t.buffer = null;
        t.peaks = null;
        console.error(`${t.name}音源の読み込みエラー:`, e);
        alert(`${t.name}音源を読み込めませんでした。別の形式（m4a / mp3 など）で試してください。`);
    }
}
 
leftFile.addEventListener("change", () => loadFile(leftFile, left));
rightFile.addEventListener("change", () => loadFile(rightFile, right));
 
 
// ===== 設定パネルの開閉 =====
settingsButton.addEventListener("click", function() {
    document.body.classList.toggle("settings-open");
});
 
 
// ===== 設定の保存と復元 =====
skipTime.value = localStorage.getItem("skipTime") ?? 5;
volumeStep.value = localStorage.getItem("volumeStep") ?? 0.1;
leftVolume.value = localStorage.getItem("leftVolume") ?? 1;
rightVolume.value = localStorage.getItem("rightVolume") ?? 1;
playbackRate.value = localStorage.getItem("playbackRate") ?? 1;
 
skipTime.addEventListener("change", function() {
    localStorage.setItem("skipTime", skipTime.value);
    updateSkipButtonText();
});
 
volumeStep.addEventListener("change", function() {
    localStorage.setItem("volumeStep", volumeStep.value);
});
 
 
// ===== 音量（スライダー・ボタン共通）。GainNodeで操作する =====
function bindVolume(slider, downButton, upButton, t, storageKey) {
    slider.step = "0.01";
 
    function apply(value) {
        value = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
        slider.value = value;
        t.volume = value;
        applyGain(t);
        localStorage.setItem(storageKey, value);
    }
 
    slider.addEventListener("input", () => apply(Number(slider.value)));
    downButton.addEventListener("click", () => apply(Number(slider.value) - Number(volumeStep.value)));
    upButton.addEventListener("click", () => apply(Number(slider.value) + Number(volumeStep.value)));
    apply(Number(slider.value));
}
 
bindVolume(leftVolume, $("leftVolumeDown"), $("leftVolumeUp"), left, "leftVolume");
bindVolume(rightVolume, $("rightVolumeDown"), $("rightVolumeUp"), right, "rightVolume");
 
 
// ===== 起動時の初期表示 =====
updateSkipButtonText();
updateButtons();
updateUI();